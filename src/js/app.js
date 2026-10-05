import MODELS_TXT from "../data/models.txt";
import { cityFromAddr, cityTidy } from "./modules/city.js";
import { apiBase } from "./modules/config.js";
import { loadScript } from "./modules/load-script.js";
import { MAPBOX_OPTIONS, mapboxConfig, mapboxTileUrl } from "./modules/mapbox.js";
import { createEnricher, missingOf } from "./modules/mapbox-fiches.js";
import { phoneList, phoneParse } from "./modules/phone.js";
import { createStore, jsonStorage } from "./modules/repair-store.js";
import { KEEP_TAG, OVERPASS_MIRRORS, inMetroFrance, overpassQuery } from "./shared/overpass.js";
import { PLATE_RE, PRICE_MAX, PRICE_MIN, YEAR_MIN } from "./shared/rules.js";
import { SERVICES } from "./shared/services.js";

(() => {
  "use strict";
  document.documentElement.lang = "fr";
  const e = "https://data.geopf.fr/geocodage/search",
    // Avec une API configurée, son relais (cache partagé, serveurs OpenStreetMap interrogés en cascade, copie périmée en
    // cas de panne) passe en premier ; les serveurs publics restent le secours, et partent tout de suite s'il ne répond pas.
    t = ((api) => (api ? [{ url: api + "/v1/overpass", name: "Pixcar" }, ...OVERPASS_MIRRORS] : OVERPASS_MIRRORS))(apiBase()),
    a = Object.assign({ stagger: 4e3, osmTimeout: 3e4, retry: 2500, sirenePace: 400, cityPause: 6e4 }, window.JG_TUNE || {}),
    n = 864e5,
    r = 40,
    s = (() => {
      const e = a.today ? new Date(a.today + "T12:00:00") : new Date();
      return `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, "0")}-${String(e.getDate()).padStart(2, "0")}`;
    })(),
    o = SERVICES,
    l = [
      { id: "norauto", name: "Norauto", re: /norauto/i, wd: ["Q3317698"] },
      { id: "feuvert", name: "Feu Vert", re: /feu\s*-?\s*vert/i, wd: ["Q3070922"] },
      { id: "speedy", name: "Speedy", re: /speedy/i, wd: ["Q3492969"] },
      { id: "midas", name: "Midas", re: /midas/i, wd: ["Q3312613"] },
      { id: "roady", name: "Roady", re: /roady/i, wd: ["Q3434112"] },
      { id: "euromaster", name: "Euromaster", re: /euromaster/i, wd: ["Q3060668"] },
      { id: "points", name: "Point S", re: /\bpoint\s*s\b/i, wd: ["Q3393358"] },
      { id: "firststop", name: "First Stop", re: /first\s*stop/i, wd: ["Q3072965"] },
      { id: "vulco", name: "Vulco", re: /vulco/i, wd: ["Q80184403"] },
      { id: "profilplus", name: "Profil Plus", re: /profil\s*(\+|plus)/i },
      { id: "siligom", name: "Siligom", re: /siligom/i },
      { id: "eurotyre", name: "Eurotyre", re: /euro\s*tyre/i, wd: ["Q3060871"] },
      { id: "bestdrive", name: "BestDrive", re: /best\s*drive/i, wd: ["Q63057183"] },
      { id: "driver", name: "Driver Center", re: /driver\s*cent(er|re)/i, wd: ["Q48180528"] },
      {
        id: "eleclerc",
        name: "E.Leclerc Auto",
        re: /\be\s*\.?\s*leclerc\b|leclerc\s+(l\W?)?auto\b/i,
        wd: ["Q1273376"],
      },
      {
        id: "cartercash",
        name: "Carter-Cash",
        re: /carter\s*-?\s*cash/i,
        only: ["montage", "equil", "crevaison"],
      },
      { id: "eurorepar", name: "Eurorepar", re: /euro\s*repar/i },
      { id: "motrio", name: "Motrio", re: /motrio/i, wd: ["Q6918585"] },
      {
        id: "ad",
        name: "AD",
        re: /(^|[\s|])AD(\s+(Expert|Garage|Carrosserie))?(?=$|[\s|])/,
        wd: ["Q108753388"],
      },
      { id: "bosch", name: "Bosch Car Service", re: /bosch\s*(car\s*)?service/i, wd: ["Q894368"] },
      { id: "topgarage", name: "Top Garage", re: /top\s*garage/i, wd: ["Q117602800"] },
      { id: "precisium", name: "Précisium", re: /precisium/i, wd: ["Q117604969"] },
      { id: "delko", name: "Delko", re: /\bdelko\b/i, wd: ["Q24934757"] },
      { id: "autoprimo", name: "Autoprimo", re: /auto\s*primo/i, wd: ["Q117610578"] },
      { id: "avatacar", name: "Avatacar", re: /avatacar/i, wd: ["Q65156251"] },
      {
        id: "glass",
        name: "Vitrage",
        re: /carglass|pare.?brise|glass/i,
        only: [],
        wd: ["Q1035997", "Q63335107", "Q118129474", "Q112064766", "Q116688243", "Q131983594", "Q120734061"],
      },
    ],
    c =
      /\b(renault|peugeot|citro[eë]n|dacia|toyota|volkswagen|ford|opel|fiat|nissan|kia|hyundai|bmw|mercedes|audi|seat|cupra|skoda|škoda|mazda|honda|suzuki|volvo|jeep|alfa romeo|mitsubishi|tesla|lexus|porsche|ferrari|maserati|lamborghini|jaguar|land rover|lotus|subaru|ssangyong|polestar|byd)\b/i,
    d = [
      ["Autosur", /autosur/i],
      ["Dekra", /dekra/i],
      ["Sécuritest", /s[ée]curitest/i],
      ["Autovision", /autovision/i],
      ["Norisko", /norisko/i],
      ["Vérif'Auto", /v[ée]rif.?auto/i],
      ["Auto Sécurité", /auto\s*s[ée]curit[ée]/i],
      ["Contrôle Auto", /contr[ôo]le\s*auto\b/i],
    ],
    u = {
      geo_av: [
        {
          c: "speedy",
          p: 39,
          from: !0,
          label: "Géométrie",
          src: "https://www.speedy.fr/pneus/prestations-pneu",
        },
        {
          c: "roady",
          p: 69.9,
          label: "Réglage du parallélisme",
          src: "https://www.roady.fr/reglage-parallelisme.html",
        },
        {
          c: "feuvert",
          p: 69.9,
          from: !0,
          label: "Forfait géométrie avant : contrôle et réglage des 2 roues avant",
          note: "existe aussi avec calibrage du capteur ESP",
          src: "https://www.feuvert.fr/prendre-rdv/geometrie-pneu.html",
        },
        {
          c: "norauto",
          p: 69.95,
          from: !0,
          label: "Réglage de la géométrie et du parallélisme",
          src: "https://www.norauto.fr/e/geometrie-parallelisme.html",
        },
        {
          c: "midas",
          p: 75,
          from: !0,
          label: "Forfaits de réglage de la géométrie",
          src: "https://www.midas.fr/blog/combien-coute-le-parallelisme-dune-voiture",
        },
      ],
      geo_4: [
        {
          c: "feuvert",
          p: 114.9,
          from: !0,
          label: "Forfait géométrie avant et arrière",
          note: "124,90 € avec calibrage du capteur ESP",
          src: "https://www.feuvert.fr/prendre-rdv/geometrie-pneu.html",
        },
        {
          c: "roady",
          p: 119.9,
          label: "Réglage de la géométrie avant et arrière",
          src: "https://www.roady.fr/tarif-horaire-t2.html",
        },
      ],
      geo_ctrl: [
        {
          c: "roady",
          p: 29.9,
          label: "Contrôle de la géométrie",
          src: "https://www.roady.fr/controle-geometrie.html",
        },
        {
          c: "feuvert",
          p: 40,
          from: !0,
          label: "Contrôle de la géométrie",
          note: "42 € sur la fiche produit ; déduit si un forfait de réglage suit",
          src: "https://www.feuvert.fr/geometrie/feu-vert-controle-de-la-geometrie-sans-reglage/p001356.html",
        },
        {
          c: "norauto",
          p: 40.95,
          label: "Contrôle de la géométrie des trains avant et arrière",
          src: "https://www.norauto.fr/e/geometrie-parallelisme.html",
        },
        {
          c: "euromaster",
          p: 50.1,
          label: "Contrôle de la géométrie avant et arrière (tourisme)",
          note: "déduit si un réglage suit",
          src: "https://www.euromaster.fr/services/services-atelier-pneus/geometrie-parallelisme/controle-geometrie",
        },
      ],
      montage: [
        {
          c: "norauto",
          p: 9.95,
          from: !0,
          label: "Montage d'un pneu, équilibrage compris",
          note: "pneus premier prix et Leonard achetés chez Norauto ; pneu acheté ailleurs dès 28,50 €",
          src: "https://www.norauto.fr/e/prestations-pneus.html",
        },
        {
          c: "feuvert",
          p: 16.95,
          from: !0,
          label: "Forfait montage en 13 à 14 pouces",
          note: "17,95 € en 15–16 pouces, 18,95 € en 17–18, 19,95 € au-delà ; pneus achetés chez Feu Vert",
          src: "https://www.feuvert.fr/montage-et-stockage/prestation-montage-pneu/c41527.html",
        },
      ],
      equil: [
        { c: "speedy", p: 10, label: "Équilibrage", src: "https://www.speedy.fr/pneus/prestations-pneu" },
      ],
      crevaison: [
        {
          c: "speedy",
          p: 25.5,
          label: "Réparation de crevaison",
          src: "https://www.speedy.fr/pneus/prestations-pneu",
        },
        {
          c: "norauto",
          p: 28.95,
          from: !0,
          label: "Réparation de crevaison, équilibrage compris",
          src: "https://www.norauto.fr/e/prestations-pneus.html",
        },
      ],
      vidange: [
        {
          c: "norauto",
          p: 59.95,
          from: !0,
          label: "Vidange : huile et filtre à huile",
          src: "https://www.norauto.fr/e/revision-vidange-entretien.html",
        },
        {
          c: "feuvert",
          p: 62.99,
          from: !0,
          label: "Forfait vidange",
          src: "https://www.feuvert.fr/prendre-rdv/revision-vidange.html",
        },
        {
          c: "speedy",
          p: 87.6,
          from: !0,
          label: "Forfait vidange basic",
          src: "https://www.speedy.fr/entretien-mecanique",
        },
        {
          c: "roady",
          p: 104.9,
          label: "Forfait vidange, huile 5W40",
          note: "119,90 € en huile 5W30",
          src: "https://www.roady.fr/forfait-vidange-roady-5w40.html",
        },
        {
          c: "midas",
          p: 149.9,
          from: !0,
          label: "Vidange et filtre à huile, véhicule de moins de 10 ans",
          note: "124,90 € de 10 à 15 ans, 99 € au-delà",
          src: "https://www.midas.fr/entretien-auto-forfaits-vidange",
        },
      ],
      clim: [
        {
          c: "roady",
          p: 64.9,
          label: "Recharge de climatisation, gaz R134a",
          note: "109,90 € en gaz R1234yf",
          src: "https://www.roady.fr/recharge-climatisation-r134a.html",
        },
        {
          c: "norauto",
          p: 64.95,
          from: !0,
          label: "Entretien clim Essentiel",
          note: "supplément de 45 € en gaz R1234yf",
          src: "https://www.norauto.fr/climatisation.html",
        },
        {
          c: "feuvert",
          p: 65,
          approx: !0,
          label: "Recharge de climatisation",
          note: "fourchette affichée : environ 65 à 150 € selon le gaz et le forfait",
          src: "https://www.feuvert.fr/prendre-rdv/climatisation.html",
        },
      ],
      diag: [
        {
          c: "norauto",
          p: 89.95,
          from: !0,
          label: "Diagnostic électronique des voyants, lecture et interprétation",
          note: "lecture seule des codes défauts dès 25,95 €",
          src: "https://www.norauto.fr/e/panne-voyant-moteur-diagnostics.html",
        },
      ],
      plaq_av: [
        {
          c: "norauto",
          p: 59.95,
          from: !0,
          label: "Changement des plaquettes",
          src: "https://www.norauto.fr/e/forfait-freinage.html",
        },
        {
          c: "feuvert",
          p: 59.99,
          from: !0,
          label: "Forfait plaquettes, pièces et main-d'œuvre comprises",
          src: "https://www.feuvert.fr/prendre-rdv/freinage.html",
        },
        {
          c: "roady",
          p: 54,
          partial: !0,
          label: "Échange des plaquettes avant",
          note: "main-d'œuvre seule, plaquettes en plus",
          src: "https://www.roady.fr/echange-plaquettes-de-frein-avant.html",
        },
      ],
      liq_frein: [
        {
          c: "norauto",
          p: 73.95,
          from: !0,
          label: "Purge et remplacement du liquide de frein",
          src: "https://www.norauto.fr/e/forfait-freinage.html",
        },
      ],
    },
    p = [
      "revision",
      "vidange",
      "plaq_av",
      "disq_av",
      "batterie",
      "distribution",
      "amortisseurs",
      "embrayage",
    ],
    m = "https://www.norauto.fr/e/conditions-des-promotions.html",
    g = "https://www.speedy.fr/conditions-des-offres",
    h = "https://www.euromaster.fr/promos",
    f = "https://www.roady.fr/conditions-des-offres.html",
    v = [
      {
        c: "norauto",
        svc: ["geo_av", "geo_4"],
        label: "−10 € immédiats sur les forfaits géométrie",
        start: "2026-09-10",
        end: "2026-10-06",
        x: { geo_av: "59,95 € au lieu de 69,95 € sur le site" },
        detail:
          "centres participants. Le bandeau du site annonce une fin au 30 septembre, les conditions le 6 octobre : confirmez en centre",
        src: m,
      },
      {
        c: "norauto",
        svc: ["vidange", "revision"],
        label: "−10 %, −20 % ou −30 % pour 1, 2 ou 3 filtres achetés",
        start: "2026-09-02",
        end: "2026-10-06",
        detail: "hors filtre à huile",
        src: m,
      },
      {
        c: "norauto",
        svc: ["vidange"],
        label: "Véhicules de plus de 15 ans : vidange dès 49,95 €",
        start: "2026-10-01",
        end: "",
        src: m,
      },
      {
        c: "norauto",
        svc: ["montage"],
        label: "Montage dès 9,95 € avec les pneus premier prix et Leonard",
        start: "",
        end: "",
        detail: "pneus achetés chez Norauto",
        src: m,
      },
      {
        c: "speedy",
        svc: ["revision"],
        label: "−25 % sur la révision constructeur",
        start: "2026-09-21",
        end: "2026-11-07",
        detail: "hors filtre à particules, amortisseurs et distribution ; particuliers",
        src: g,
      },
      {
        c: "speedy",
        svc: ["vidange"],
        label: "−30 % sur le forfait vidange basic, réservé à speedy.fr",
        start: "2026-09-21",
        end: "2026-11-08",
        detail: "huiles hors 10W40, 5 litres compris puis 12 € le litre ; centres participants",
        src: g,
      },
      {
        c: "speedy",
        svc: ["vidange", "revision"],
        label: "Véhicules de plus de 10 ans : −25 % sur les forfaits d'entretien",
        start: "2026-09-21",
        end: "2026-11-07",
        x: { vidange: "68,40 € affiché sur la page vidange" },
        detail: "rendez-vous pris en ligne sur speedy.fr",
        src: g,
      },
      {
        c: "speedy",
        svc: ["plaq_av", "disq_av"],
        label: "−30 % sur les pièces de freinage Ferodo",
        start: "2026-09-21",
        end: "2026-11-07",
        detail: "disques, plaquettes et kits ; main-d'œuvre non remisée",
        src: g,
      },
      {
        c: "speedy",
        svc: ["amortisseurs"],
        label: "Amortisseurs Monroe : 2 achetés à l'avant, 2 offerts à l'arrière",
        start: "2026-09-21",
        end: "2026-11-07",
        detail: "hors suspension pilotée ; main-d'œuvre non offerte",
        src: g,
      },
      {
        c: "speedy",
        svc: ["embrayage"],
        label: "−30 % sur les pièces d'embrayage Valeo",
        start: "2026-09-21",
        end: "2026-11-07",
        detail: "kits, butées, câbles, cylindres et volants moteur",
        src: g,
      },
      {
        c: "speedy",
        svc: ["distribution"],
        label: "−30 % sur les kits de distribution Gates",
        start: "2026-09-21",
        end: "2026-11-07",
        detail: "courroie, galets et pompe à eau",
        src: g,
      },
      {
        c: "speedy",
        svc: ["batterie"],
        label: "−20 % sur les batteries Fulmen",
        start: "2026-09-21",
        end: "2026-11-07",
        src: g,
      },
      {
        c: "speedy",
        svc: ["montage"],
        label: "Montage à −50 % pour 2 ou 4 pneus Pirelli ou Firestone achetés sur speedy.fr",
        start: "2026-09-21",
        end: "2026-11-08",
        detail: "en plus : 20 % remboursés sur les Pirelli, jusqu'à 80 € sur les Firestone",
        src: g,
      },
      {
        c: "euromaster",
        svc: ["plaq_av", "disq_av"],
        label: "−20 % sur les freins",
        start: "2026-08-31",
        end: "2026-10-04",
        src: h,
      },
      {
        c: "euromaster",
        svc: ["revision", "vidange"],
        label: "−20 % sur la révision et la vidange",
        start: "2026-08-31",
        end: "2026-10-04",
        src: h,
      },
      {
        c: "euromaster",
        svc: ["montage"],
        label: "Montage 100 % remboursé avec des pneus Michelin ou Continental",
        start: "2026-08-31",
        end: "2026-10-04",
        detail: "remboursement après l'achat",
        src: h,
      },
      {
        c: "euromaster",
        svc: ["montage"],
        label: "Pneus Tigar : 50 % du montage offert",
        start: "2026-07-27",
        end: "2026-10-04",
        src: h,
      },
      {
        c: "midas",
        svc: p,
        label: "−30 % avec le code OFFRE30",
        start: "",
        end: "2026-10-10",
        detail:
          "révision, forfaits d'entretien (hors huile 15W40) et pièces hors pneus ; main-d'œuvre exclue ; 100 € d'achat minimum, remise plafonnée à 200 € ; non cumulable ; centres participants",
        src: "https://www.midas.fr/contenu/offre-30-revision-pieces-hors-pneus-forfaits",
      },
      {
        c: "midas",
        svc: p,
        label: "Véhicules de plus de 15 ans : −25 % sur les pièces et forfaits",
        start: "2026-08-31",
        end: "2026-10-24",
        detail: "centres participants",
        src: "https://www.midas.fr/entretien-auto-forfaits-vidange",
      },
      {
        c: "midas",
        svc: p,
        label: "Moins de 25 ans : −25 % avec le code 25ANS",
        start: "",
        end: "2026-12-31",
        src: "https://www.midas.fr/contenu/offre-jeunes",
      },
      {
        c: "roady",
        svc: ["vidange"],
        label: "−20 % immédiats sur la vidange",
        start: "2026-10-01",
        end: "2026-10-31",
        detail: "main-d'œuvre, huile et pièces du forfait",
        src: f,
      },
      {
        c: "roady",
        svc: ["montage", "equil"],
        label: "Montage, valve et équilibrage offerts avec des pneus Bridgestone",
        start: "2026-10-01",
        end: "2026-10-31",
        detail: "4 pneus maximum ; valves électroniques exclues",
        src: f,
      },
      {
        c: "roady",
        svc: ["distribution"],
        label: "−50 € immédiats sur le kit de distribution SKF posé",
        start: "2026-10-01",
        end: "2026-10-31",
        src: f,
      },
    ],
    // Catalogue des modèles proposés dans le formulaire de réparation : voir src/data/models.txt (une ligne par marque,
    // « Marque: modèle, modèle… », les plus courants d'abord). La liste des noms (b) et celle des marques (O) en sont déduites.
    CARS = MODELS_TXT.trim()
      .split("\n")
      .map((l) => {
        const i = l.indexOf(":");
        return [l.slice(0, i), l.slice(i + 1).split(",").map((m) => m.trim())];
      }),
    b = CARS.flatMap(([brand, models]) => models.map((m) => brand + " " + m)),
    w = (e, t = document) => t.querySelector(e),
    y = (e) =>
      String(e ?? "").replace(
        /[&<>"']/g,
        (e) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[e],
      ),
    $ = (e) =>
      null == e || "" === e
        ? NaN
        : "number" == typeof e
          ? e
          : parseFloat(
              String(e)
                .replace(",", ".")
                .replace(/[^\d.\-]/g, ""),
            ),
    k = (e) =>
      String(e || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, ""),
    S = (e) => new Promise((t) => setTimeout(t, e)),
    M = new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }),
    x = new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
    C = (e) => (Math.abs(e - Math.round(e)) < 0.005 ? M : x).format(e);
  function A(e) {
    return e < 1
      ? [String(Math.max(10, 10 * Math.round(100 * e))), "m"]
      : e < 10
        ? [e.toFixed(1).replace(".", ","), "km"]
        : [String(Math.round(e)), "km"];
  }
  const E = (e) => A(e).join(" ");
  function _(e, t) {
    const a = Math.PI / 180,
      n = (t.lat - e.lat) * a,
      r = (t.lon - e.lon) * a,
      s = Math.sin(n / 2) ** 2 + Math.cos(e.lat * a) * Math.cos(t.lat * a) * Math.sin(r / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function F(e, t = {}, a = 15e3) {
    const n = new AbortController(),
      r = setTimeout(() => n.abort(), a);
    return (
      t.signal && t.signal.addEventListener("abort", () => n.abort(), { once: !0 }),
      fetch(e, { ...t, signal: n.signal }).finally(() => clearTimeout(r))
    );
  }
  const P = {
    get(e, t) {
      try {
        const a = localStorage.getItem(e);
        return a ? JSON.parse(a) : t;
      } catch (e) {
        return t;
      }
    },
    set(e, t) {
      try {
        localStorage.setItem(e, JSON.stringify(t));
      } catch (e) {}
    },
  };
  function R(e) {
    try {
      return new URL(e).hostname.replace(/^www\./, "");
    } catch (t) {
      return e;
    }
  }
  function q(e) {
    return (
      (e = String(e || "")
        .replace(/\s+/g, " ")
        .trim()).length > 4 &&
        e === e.toUpperCase() &&
        /[A-Z]/.test(e) &&
        (e = e.toLowerCase().replace(/(^|[\s\-'’(./])([a-zà-ÿ])/g, (e, t, a) => t + a.toUpperCase())),
      e
    );
  }
  function I(e) {
    const t = { Mo: "lun", Tu: "mar", We: "mer", Th: "jeu", Fr: "ven", Sa: "sam", Su: "dim", PH: "fériés" };
    return String(e)
      .replace(/24\/7/, "7 j/7, 24 h/24")
      .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (e) => t[e])
      .replace(/\boff\b/gi, "fermé")
      .replace(/\s*;\s*/g, " · ")
      .replace(/,(?=\S)/g, ", ");
  }
  function T(e) {
    return (e = String(e || "").trim()) ? (/^https?:\/\//i.test(e) ? e : "https://" + e) : "";
  }
  const D = (e) => l.find((t) => t.id === e),
    j = (e) => ("autre" === e ? "Autre réparation" : (o.find((t) => t.id === e) || {}).label || "Prestation"),
    z = [
      "janvier",
      "février",
      "mars",
      "avril",
      "mai",
      "juin",
      "juillet",
      "août",
      "septembre",
      "octobre",
      "novembre",
      "décembre",
    ];
  function B(e) {
    const [t, a, n] = String(e || "")
      .split("-")
      .map(Number);
    return !t || !a || !n || a > 12 ? String(e || "") : `${1 === n ? "1er" : n} ${z[a - 1]} ${t}`;
  }
  function N(e) {
    const t = e.filter(Number.isFinite).sort((e, t) => e - t);
    if (!t.length) return NaN;
    const a = t.length >> 1;
    return t.length % 2 ? t[a] : (t[a - 1] + t[a]) / 2;
  }
  const V = (e, t, a) => `${e} ${e > 1 ? a : t}`;
  function G(e) {
    const [t, a] = String(e || "")
      .split("-")
      .map(Number);
    return t && a && a <= 12 ? `${z[a - 1]} ${t}` : "";
  }
  const H = (e) =>
      k(e)
        .replace(/[^a-z0-9]+/g, " ")
        .trim(),
    W = b.map((e) => ({ m: e, k: H(e) })).sort((e, t) => t.k.length - e.k.length),
    O = ["Mercedes-Benz", ...CARS.map(([brand]) => brand)]
      .map((e) => ({ b: e, k: H(e) }))
      .sort((e, t) => t.k.length - e.k.length),
    Q = (() => {
      const e = new Map();
      for (const { m: t, k: a } of W) {
        const n = O.find((e) => a.startsWith(e.k + " "));
        if (!n) continue;
        const r = a.slice(n.k.length + 1);
        if (r.length < 2) continue;
        (e.has(r) || e.set(r, []), e.get(r).push(t));
      }
      return [...e].sort((e, t) => t[0].length - e[0].length);
    })(),
    K = (e, t) => e === t || e.startsWith(t + " ");
  function U(e) {
    return String(e || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((e) =>
        /\d/.test(e) || /^[IVX]{1,4}$/i.test(e)
          ? e.toUpperCase()
          : e.toLowerCase().replace(/(^|[-'’])(\p{L})/gu, (e, t, a) => t + a.toUpperCase()),
      )
      .join(" ");
  }
  function X(e, t) {
    const a = t.split(" ").length,
      n = e.split(/\s+/);
    let r = 0,
      s = 0;
    for (; r < n.length && s < a; ) ((s += H(n[r]).split(" ").filter(Boolean).length), r++);
    return n.slice(r).join(" ");
  }
  function J(e) {
    let t = String(e || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40)
      .replace(/^mercedes[\s-]*benz\b/i, "Mercedes")
      .replace(/^vw\b/i, "Volkswagen");
    if (!t) return "";
    const a = H(t);
    if (!a) return t;
    for (const { m: e, k: n } of W) if (K(a, n)) return (e + " " + U(X(t, n))).trim();
    for (const [e, n] of Q)
      if (K(a, e)) {
        if (1 === n.length) return (n[0] + " " + U(X(t, e))).trim();
        break;
      }
    const n = O.find((e) => K(a, e.k));
    return n ? (n.b + " " + U(X(t, n.k))).trim() : t === t.toUpperCase() || t === t.toLowerCase() ? U(t) : t;
  }
  // État d'envoi d'une réparation de ce navigateur (mode distant seulement)
  const stateLabel = (e) =>
    "remote" !== RS.mode
      ? ""
      : "pending" === e.sync
        ? "En attente d'envoi"
        : "local" === e.sync
          ? "Gardée sur cet appareil"
          : "pending" === e.review
            ? "En relecture avant publication"
            : "";
  function Y(e) {
    return {
      id: e.id,
      own: !e.shared,
      sync: e.sync,
      review: e.review,
      serviceId: e.serviceId,
      price: e.price,
      month: String(e.date).slice(0, 7),
      model: e.model || "",
      year: e.year || 0,
      rating: Z(e.rating) ? e.rating : 0,
    };
  }
  const Z = (e) => Number.isInteger(e) && e >= 1 && e <= 5,
    ee = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }),
    te = (e) => ee.format(Math.round(10 * e) / 10);
  function ae(e) {
    const t = e.map((e) => e.rating).filter(Z);
    return t.length ? { avg: t.reduce((e, t) => e + t, 0) / t.length, n: t.length } : null;
  }
  const ne = '<svg viewBox="0 0 24 24"><use href="#i-star"/></svg>'.repeat(5);
  function re(e) {
    const t = Math.max(0, Math.min(100, (e / 5) * 100)).toFixed(0);
    return `<span class="stars" aria-hidden="true"><span class="s-off">${ne}</span><span class="s-on" style="width:${t}%">${ne}</span></span>`;
  }
  const se =
    '<svg viewBox="0 0 9 11" aria-hidden="true"><path d="M1.2 10.5V.8M1.2 1.2h6.6L6 3.6l1.8 2.4H1.2" fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  function ie(e) {
    return e.end && e.end < s ? "ended" : e.start && e.start > s ? "soon" : "active";
  }
  function oe(e, t) {
    return v
      .filter((a) => a.c === e && a.svc.includes(t))
      .map((e) => ({ ...e, st: ie(e) }))
      .filter((e) => "ended" !== e.st)
      .sort((e, t) => ("soon" === e.st) - ("soon" === t.st));
  }
  const le = (e) => (e || []).some((e) => "active" === e.st);
  function ce(e) {
    return le(e)
      ? `<span class="tag promo">${se}Promo</span>`
      : (e || []).length
        ? '<span class="tag neutral">Promo à venir</span>'
        : "";
  }
  function de(e) {
    return "soon" === e.st
      ? `à partir du ${B(e.start)}${e.end ? `, jusqu'au ${B(e.end)}` : ""}`
      : e.end
        ? `jusqu'au ${B(e.end)}`
        : e.start
          ? `depuis le ${B(e.start)}, sans date de fin publiée`
          : "dates non publiées";
  }
  function ue(e, t) {
    return `<ul class="promos" aria-label="Promotions">${e.map((e) => `<li class="${e.st}"><b>${y(e.label)}</b><span class="pm">${y([de(e), e.x && e.x[t], e.detail].filter(Boolean).join(" · "))} · <a href="${y(e.src)}" target="_blank" rel="noopener">conditions</a></span></li>`).join("")}</ul>`;
  }
  const pe = {
      form: w("#searchForm"),
      service: w("#service"),
      hint: w("#serviceHint"),
      address: w("#address"),
      addrList: w("#addrList"),
      locate: w("#locateBtn"),
      radius: w("#radius"),
      chips: w("#radiusChips"),
      energyField: w("#energyField"),
      energy: w("#energy"),
      more: w("#moreOpts"),
      sirene: w("#sirene"),
      go: w("#go"),
      goLabel: w("#goLabel"),
      banner: w("#modeBanner"),
      status: w("#status"),
      summary: w("#summary"),
      repairNote: w("#repairNote"),
      toolbar: w("#toolbar"),
      map: w("#map"),
      mapPane: w("#mapPane"),
      list: w("#list"),
      moreBtn: w("#moreBtn"),
      refList: w("#refList"),
      addBtn: w("#addRepairBtn"),
      toast: w("#toast"),
      tabs: w("#tabs"),
      sumWhere: w("#sumWhere"),
      editSearch: w("#editSearch"),
      teaser: w("#teaser"),
      resBody: w("#resBody"),
      mapFab: w("#mapFab"),
      osmNote: w("#osmNote"),
      refService: w("#refService"),
      panelCol: w("#panelCol"),
      mapInfo: w("#mapInfo"),
    },
    me = {
      mode: "unknown",
      probe: null,
      place: null,
      raw: [],
      garages: [],
      kind: null,
      fetchedKm: 0,
      view: [],
      shown: r,
      sort: "price",
      filter: "all",
      notes: [],
      busy: !1,
      screen: "garages",
      viewMode: "list",
      openIds: new Set(),
      sel: null,
      mapKey: "",
      mapDirty: !1,
      cachedAt: 0,
    },
    ge = () => matchMedia("(min-width:1024px)").matches,
    he = (e, t) => `<svg class="ic${t ? " " + t : ""}" aria-hidden="true"><use href="#i-${e}"/></svg>`;
  !(function () {
    const e = [];
    for (const t of o) {
      let a = e.find((e) => e.name === t.g);
      (a || e.push((a = { name: t.g, items: [] })), a.items.push(t));
    }
    const t = e
      .map(
        (e) =>
          `<optgroup label="${y(e.name)}">${e.items.map((e) => `<option value="${e.id}">${y(e.label)}</option>`).join("")}</optgroup>`,
      )
      .join("");
    ((pe.service.innerHTML = t), (pe.refService.innerHTML = t));
  })();
  const fe = () => {
    return ((e = pe.service.value), o.find((t) => t.id === e) || o[0]);
    var e;
  };
  function ve() {
    const e = fe();
    ((pe.hint.textContent = e.hint || ""),
      (pe.energyField.hidden = "ct" !== e.kind),
      (pe.more.hidden = "ct" === e.kind),
      (pe.goLabel.textContent = "ct" === e.kind ? "Rechercher les centres" : "Rechercher les garages"),
      (pe.refService.value = pe.service.value),
      (function () {
        const e = fe();
        if ("ct" === e.kind)
          return void (pe.refList.innerHTML =
            '<li class="ref-empty">Chaque centre déclare ses propres tarifs. La recherche affiche le prix officiel de chaque centre autour de votre adresse. Données publiques : <a href="https://prix.conso.gouv.fr/controle-technique" target="_blank" rel="noopener">prix.conso.gouv.fr</a>.</li>');
        const t = (u[e.id] || [])
            .slice()
            .sort((e, t) => (e.partial ? 1 : 0) - (t.partial ? 1 : 0) || e.p - t.p),
          a = t.filter((e) => !e.partial).length > 1;
        let n = t
          .map((t, n) => {
            const r = oe(t.c, e.id);
            return `\n    <li>\n      <span class="ref-chain">${av(D(t.c).name, D(t.c))}${y(D(t.c).name)}${0 === n && a && !t.partial ? ' <span class="tag ok">Le moins cher</span>' : ""}${t.partial ? ' <span class="tag warn">Pièces en plus</span>' : ""}${r.length ? " " + ce(r) : ""}</span>\n      <span class="ref-label">${y(t.label)}</span>\n      <span class="ref-price">${t.approx ? "<small>env.</small> " : ""}${C(t.p)}${e.unit ? `<br><small>${y(e.unit)}</small>` : ""}</span>\n      ${t.note ? `<span class="ref-note">${y(t.note)}</span>` : ""}\n      ${r.length ? `<div class="ref-promos">${ue(r, e.id)}</div>` : ""}\n      <a class="ref-src" href="${y(t.src)}" target="_blank" rel="noopener">Source : ${y(R(t.src))}</a>\n    </li>`;
          })
          .join("");
        t.length ||
          (n =
            '<li class="ref-empty">Aucune grande enseigne n\'affiche de prix national pour cette prestation : il dépend du modèle. Demandez un devis aux garages trouvés, puis déclarez le prix payé avec « Ajouter une réparation ».</li>');
        const r = new Set(t.map((e) => e.c)),
          s = [...new Set(v.filter((t) => t.svc.includes(e.id) && !r.has(t.c)).map((e) => e.c))]
            .map((t) => ({ c: t, ps: oe(t, e.id) }))
            .filter((e) => e.ps.length);
        (s.length &&
          ((n += `<li class="ref-sub">${t.length ? "Promotions d'autres enseignes" : "Promotions des enseignes"} sur cette prestation</li>`),
          (n += s
            .map(
              (t) =>
                `\n    <li>\n      <span class="ref-chain">${av(D(t.c).name, D(t.c))}${y(D(t.c).name)} ${ce(t.ps)}</span>\n      <span class="ref-label">Pas de prix national publié : tarif fixé par chaque centre.</span>\n      <div class="ref-promos">${ue(t.ps, e.id)}</div>\n    </li>`,
            )
            .join(""))),
          (pe.refList.innerHTML = n));
      })(),
      be());
  }
  function be() {
    const e = fe();
    if (((pe.teaser.hidden = me.raw.length > 0), pe.teaser.hidden)) return;
    let t;
    if ("ct" === e.kind)
      t =
        "Chaque centre agréé déclare ses prix à la DGCCRF : la recherche affiche le prix officiel de chaque centre autour de votre adresse.";
    else {
      const a = (u[e.id] || []).filter((e) => !e.partial),
        n = new Set(v.filter((t) => t.svc.includes(e.id) && "active" === ie(t)).map((e) => e.c)).size;
      if (a.length > 1) {
        const n = a.reduce((e, t) => (t.p < e.p ? t : e)),
          r = a.reduce((e, t) => (t.p > e.p ? t : e));
        t = `Dans les grandes enseignes, de <b>${C(n.p)}</b> chez ${y(D(n.c).name)} à <b>${C(r.p)}</b> chez ${y(D(r.c).name)}${e.unit ? " " + y(e.unit) : ""} (prix «\u00a0à\u00a0partir\u00a0de\u00a0»).`;
      } else
        t = a.length
          ? `Prix publié : <b>${C(a[0].p)}</b> chez ${y(D(a[0].c).name)}${e.unit ? " " + y(e.unit) : ""}.`
          : "Aucune grande enseigne n'affiche de prix national : il dépend du modèle. Demandez des devis, puis déclarez le prix payé.";
      n &&
        (t += ` ${n > 1 ? `${n} enseignes ont une promotion en cours` : "Une enseigne a une promotion en cours"}.`);
    }
    pe.teaser.innerHTML = `<h2>${y(e.label)} : les repères</h2><p>${t}</p><p><a href="#prix">Voir les prix et promotions des enseignes</a></p>`;
  }
  async function we() {
    try {
      const t = await F(`${e}?q=lyon&limit=1`, {}, 6e3);
      if (!t.ok) throw new Error("geo " + t.status);
      (await t.json(),
        (me.mode = "live"),
        (pe.banner.hidden = !0),
        me.raw.length && ((pe.mapPane.hidden = pe.mapFab.hidden = !me.place), Et()));
    } catch (e) {
      ((me.mode = "preview"), (pe.banner.hidden = !1));
    }
  }
  function ye(e) {
    const t = String(e.citycode || "");
    return t
      ? t.startsWith("97")
        ? t.slice(0, 3)
        : t.slice(0, 2)
      : String(e.context || "")
          .split(",")[0]
          .trim();
  }
  async function $e(t, a = 5, n = !0, r) {
    const s = `${e}?q=${encodeURIComponent(t)}&limit=${a}`;
    let i = await F(s + (n ? "&autocomplete=1" : ""), { signal: r }, 8e3);
    if ((!i.ok && n && (i = await F(s, { signal: r }, 8e3)), !i.ok)) throw new Error("geo " + i.status);
    return ((await i.json()).features || [])
      .map((e) => {
        const a = e.properties || {},
          n = (e.geometry && e.geometry.coordinates) || [];
        return {
          label: a.label || a.name || t,
          lat: $(n[1]),
          lon: $(n[0]),
          type: a.type || "",
          city: a.city || "",
          postcode: a.postcode || "",
          context: a.context || "",
          dep: ye(a),
        };
      })
      .filter((e) => isFinite(e.lat) && isFinite(e.lon));
  }
  pe.refService.addEventListener("change", () => {
    ((pe.service.value = pe.refService.value), pe.service.dispatchEvent(new Event("change")));
  });
  const ke = { housenumber: "Adresse", street: "Voie", municipality: "Commune", locality: "Lieu-dit" };
  let Se = null,
    Me = null,
    xe = [],
    Le = -1;
  function Ce() {
    ((pe.addrList.hidden = !0), pe.address.setAttribute("aria-expanded", "false"), (Le = -1));
  }
  function Ae() {
    xe.length
      ? ((pe.addrList.innerHTML = xe
          .map(
            (e, t) =>
              `<li role="option" id="sug-${t}" data-i="${t}" aria-selected="${t === Le}"><span class="s-main">${y(e.label)}</span><span class="s-sub">${y([ke[e.type] || "", e.context].filter(Boolean).join(" · "))}</span></li>`,
          )
          .join("")),
        (pe.addrList.hidden = !1),
        pe.address.setAttribute("aria-expanded", "true"),
        Le >= 0
          ? pe.address.setAttribute("aria-activedescendant", "sug-" + Le)
          : pe.address.removeAttribute("aria-activedescendant"))
      : Ce();
  }
  function Ee(e) {
    const t = xe[e];
    t && ((me.place = t), (pe.address.value = t.label), Ce(), na());
  }
  function _e() {
    for (const e of pe.chips.querySelectorAll(".chip"))
      e.setAttribute("aria-pressed", String(e.dataset.km === pe.radius.value));
    Fe();
  }
  function Fe() {
    const e = me.place ? me.place.label : pe.address.value.trim() || "Adresse à préciser";
    pe.sumWhere.textContent = `${e}\u00a0· ${pe.radius.value}\u00a0km`; // insécables : la ligne ne commence jamais par « · »
  }
  function Pe(e) {
    (pe.form.classList.toggle("is-collapsed", e),
      pe.editSearch.setAttribute("aria-expanded", String(!e)),
      Fe());
  }
  (pe.address.addEventListener("input", () => {
    ((me.place = null), clearTimeout(Se));
    const e = pe.address.value.trim();
    e.length < 3 || "preview" === me.mode
      ? Ce()
      : (Se = setTimeout(
          () =>
            (async function (e) {
              (Me && Me.abort(), (Me = new AbortController()));
              try {
                ((xe = await $e(e, 6, !0, Me.signal)), (Le = -1), Ae());
              } catch (e) {
                "AbortError" !== e.name && Ce();
              }
            })(e),
          220,
        ));
  }),
    pe.address.addEventListener("keydown", (e) => {
      pe.addrList.hidden ||
        ("ArrowDown" === e.key
          ? (e.preventDefault(), (Le = (Le + 1) % xe.length), Ae())
          : "ArrowUp" === e.key
            ? (e.preventDefault(), (Le = (Le - 1 + xe.length) % xe.length), Ae())
            : "Enter" === e.key && Le >= 0
              ? (e.preventDefault(), Ee(Le))
              : "Escape" === e.key && Ce());
    }),
    pe.addrList.addEventListener("mousedown", (e) => e.preventDefault()),
    pe.addrList.addEventListener("click", (e) => {
      const t = e.target.closest("li[data-i]");
      t && Ee(+t.dataset.i);
    }),
    pe.address.addEventListener("blur", () => setTimeout(Ce, 120)),
    pe.locate.addEventListener("click", () => {
      "geolocation" in navigator
        ? (dt("Localisation en cours…"),
          navigator.geolocation.getCurrentPosition(
            (e) => {
              ((me.place = {
                label: "Ma position",
                lat: e.coords.latitude,
                lon: e.coords.longitude,
                dep: "",
              }),
                (pe.address.value = "Ma position"),
                dt("Position trouvée. Lancez la recherche."));
            },
            () => dt("Position refusée ou indisponible : saisissez une adresse.", "err"),
            { timeout: 9e3, maximumAge: 3e5 },
          ))
        : dt("La localisation n'est pas disponible ici : saisissez une adresse.", "err");
    }),
    pe.editSearch.addEventListener("click", () => {
      (Pe(!1), pe.address.focus(), pe.address.select());
    }),
    pe.chips.addEventListener("click", (e) => {
      const t = e.target.closest(".chip");
      t &&
        ((pe.radius.value = t.dataset.km),
        _e(),
        na(),
        me.raw.length &&
          (+pe.radius.value <= me.fetchedKm
            ? ht()
            : dt(`Relancez la recherche pour élargir la zone à ${pe.radius.value} km.`)));
    }));
  const Re = "jg.osm.v3";
  try {
    (localStorage.removeItem("jg.osm.v1"), localStorage.removeItem("jg.osm.v2"));
  } catch (e) {}
  const qe = KEEP_TAG;
  function Ie(e, t, a, r = 3 * n) {
    const s = P.get(Re, {}) || {},
      i = `${e.toFixed(4)},${t.toFixed(4)}`;
    let o = null;
    for (const e in s) {
      const t = s[e];
      t && t.at === i && t.m >= a && Date.now() - t.t < r && (!o || t.t > o.t) && (o = t);
    }
    return o ? { els: o.els, t: o.t } : null;
  }
  const Te = inMetroFrance;
  function De(e) {
    return e && e.report ? e.report.map((e) => `${e.name} : ${e.status}`).join(" · ") : "erreur inconnue";
  }
  function je(e) {
    const t = [e["brand:wikidata"], e["operator:wikidata"]]
      .filter(Boolean)
      .join(";")
      .split(/\s*;\s*/)
      .filter(Boolean);
    if (t.length) for (const e of l) if (e.wd && e.wd.some((e) => t.includes(e))) return e;
    const a = [e.brand, e.name, e.operator, e["brand:fr"]].filter(Boolean).join(" | ");
    if (!a) return null;
    const n = k(a);
    for (const e of l) if (e.re.test(a) || e.re.test(n)) return e;
    return null;
  }
  const ze = (e) => Object.keys(e).some((t) => t.startsWith("service:vehicle:") && "yes" === e[t]);
  // ----- Adresses manquantes : adresse la plus proche de la position (Base Adresse Nationale, Géoplateforme IGN) -----
  // OpenStreetMap n'a pas toujours l'adresse d'un garage (beaucoup de Speedy, par exemple). À l'ouverture d'une fiche ou à
  // la sélection d'un garage sans rue, on demande à la BAN l'adresse la plus proche de sa position (80 m au plus) et on
  // l'affiche précédée de « ≈ » : c'est une approximation, pas l'adresse déclarée. Réponse gardée 90 jours (un refus, 7
  // jours) ; un échec réseau n'est jamais mémorisé.
  const adKey = "jg.addr.v1",
    adRange = 80,
    adTtl = 90 * 864e5,
    adNoTtl = 7 * 864e5,
    adCap = 400,
    adWait = new Map();
  let adMem = P.get(adKey, null);
  adMem = adMem && "object" == typeof adMem && !Array.isArray(adMem) ? adMem : {};
  const adId = (g) => `${g.lat.toFixed(5)},${g.lon.toFixed(5)}`,
    adFresh = (e) => !!e && Number.isFinite(e.t) && Date.now() - e.t < (e.a ? adTtl : adNoTtl),
    adText = (g) => (g.addr ? (g.addrApprox ? "≈ " : "") + g.addr : ""),
    adTitle = (g) =>
      g.addrApprox
        ? `Adresse la plus proche de la position du garage${g.addrDist >= 0 ? " (à " + g.addrDist + " m)" : ""}, d'après la Base Adresse Nationale : à titre indicatif`
        : "",
    adTitleAttr = (g) => (g.addrApprox ? ` title="${y(adTitle(g))}"` : ""),
    adHtml = (g, short) =>
      g.addr
        ? (g.addrApprox ? '<span aria-hidden="true">≈ </span><span class="sr-only">Environ </span>' : "") +
          y(g.addr)
        : g.addrBusy
          ? "Recherche de l'adresse…"
          : short
            ? "Non renseignée"
            : "Adresse non renseignée",
    adGoogle = (e) =>
      `https://www.google.com/maps/search/${encodeURIComponent([e.name && !/^(Garage \(nom|Spécialiste pneus \(sans)/.test(e.name) ? e.name : "garage", e.addr].filter(Boolean).join(", "))}/@${e.lat.toFixed(6)},${e.lon.toFixed(6)},17z`;
  function adSave() {
    const ks = Object.keys(adMem);
    if (ks.length > adCap)
      for (const k of ks.sort((a, b) => adMem[a].t - adMem[b].t).slice(0, ks.length - adCap)) delete adMem[k];
    P.set(adKey, adMem);
  }
  function adApply(g, e) {
    ((g.addr = e.a), (g.addrApprox = !0), (g.addrDist = e.d));
  }
  // à la création d'un garage OSM sans rue : reprend une réponse déjà obtenue
  function adInit(g) {
    if (g.addrGap) {
      const e = adMem[adId(g)];
      adFresh(e) && e.a && adApply(g, e);
    }
    return g;
  }
  function adRepaint(g) {
    for (const n of document.querySelectorAll(`[data-ad="${CSS.escape(g.id)}"]`)) {
      ((n.innerHTML = adHtml(g, !!n.parentElement && "DD" === n.parentElement.tagName)),
        n.classList.toggle("is-busy", !!g.addrBusy));
      g.addrApprox ? n.setAttribute("title", adTitle(g)) : n.removeAttribute("title");
    }
    me.sel === g.id && Mk.has(g.id) && bindTip(Mk.get(g.id), g, !0);
    const c = pe.list.querySelector(`[data-id="${CSS.escape(g.id)}"] .act-reviews`);
    (c && (c.href = adGoogle(g)), cityRepaint(g));
  }
  function adFetch(g) {
    const k = adId(g);
    if (adWait.has(k)) return adWait.get(k);
    const p = (async () => {
      try {
        const r = await F(
          `https://data.geopf.fr/geocodage/reverse?lon=${g.lon}&lat=${g.lat}&limit=1`,
          {},
          7e3,
        );
        if (!r.ok) throw new Error("reverse " + r.status);
        const f = ((await r.json()).features || [])[0] || {},
          o = f.properties || {},
          c = (f.geometry || {}).coordinates,
          a = q(
            o.name && (o.postcode || o.city)
              ? `${o.name}, ${[o.postcode, o.city].filter(Boolean).join(" ")}`
              : o.label || "",
          ),
          d =
            Array.isArray(c) && Number.isFinite(+c[0]) && Number.isFinite(+c[1])
              ? 1e3 * _(g, { lat: +c[1], lon: +c[0] })
              : +o.distance,
          // la commune de l'adresse la plus proche (250 m au plus) sert à la puce distance, même quand l'adresse elle-même est refusée
          cy = d >= 0 && d <= cityRange ? cityTidy(o.city) || cityFromAddr(o.label) : "",
          e =
            a && d >= 0 && d <= adRange
              ? { a, d: Math.round(d), c: cy, t: Date.now() }
              : { a: "", c: cy, t: Date.now() };
        return ((adMem[k] = e), adSave(), e);
      } catch (e) {
        return null;
      } finally {
        adWait.delete(k);
      }
    })();
    return (adWait.set(k, p), p);
  }
  // Appelé à l'ouverture d'une fiche et à la sélection : une seule demande par position, une nouvelle tentative au plus
  function adEnsure(g) {
    if (!g || "osm" !== g.src || !g.addrGap || g.addrApprox || g.addrBusy || g.addrFin)
      return Promise.resolve();
    if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) return Promise.resolve();
    const e = adMem[adId(g)];
    if (adFresh(e)) return ((g.addrFin = !0), e.a && (adApply(g, e), adRepaint(g)), Promise.resolve());
    return (
      (g.addrBusy = !0),
      adRepaint(g),
      adFetch(g).then((e) => {
        ((g.addrBusy = !1),
          e
            ? ((g.addrFin = !0), e.a && adApply(g, e))
            : (g.addrFail = (g.addrFail || 0) + 1) > 1 && (g.addrFin = !0),
          adRepaint(g));
      })
    );
  }
  // ----- Fiches complétées par Mapbox (téléphone, horaires, site) -----
  // OpenStreetMap n'a pas toujours le téléphone, les horaires ou le site d'un garage (et le registre SIRENE n'en a aucun). À l'ouverture d'une fiche qui
  // en manque, une requête « Search Box » à Mapbox (modules/mapbox-fiches.js) cherche le lieu au même endroit, de même nom, et ne remplit que ce qui
  // manque, avec la mention « Mapbox ». Une requête par garage et par visite au plus (40 au plus, rien si la fiche est complète), aucune réponse gardée
  // sur le disque. Actif seulement avec un jeton Mapbox (réglage « enrich » de src/mapbox.json : « map » = tant que la carte affiche des tuiles Mapbox,
  // « always », « off »). Interrupteur : window.JG_MAPBOX_ENRICH = false.
  let mbxLive = !1, // la carte affiche des tuiles Mapbox
    mbxFallen = !1, // Mapbox a été abandonné pour l'IGN ou CARTO (tuiles refusées)
    mbxEnr = null;
  const mbxCfg = mapboxConfig(),
    mbxOn = () =>
      !!mbxCfg &&
      "off" !== mbxCfg.enrich &&
      window.JG_MAPBOX_ENRICH !== !1 &&
      ("always" === mbxCfg.enrich ? !mbxFallen : mbxLive),
    mbxWant = (g) =>
      mbxOn() &&
      !!g &&
      ("osm" === g.src || "sirene" === g.src) &&
      Number.isFinite(g.lat) &&
      Number.isFinite(g.lon) &&
      !g.mbxDone &&
      !g.mbxBusy &&
      (g.mbxTry || 0) < 2 &&
      missingOf(g);
  // Repeint ce que la réponse change : les lignes de la fiche (téléphone, horaires, site) et le bouton « Appeler » de la carte
  function mbxRepaint(g) {
    const li = pe.list.querySelector(`[data-id="${CSS.escape(g.id)}"]`);
    if (!li) return;
    const act = li.querySelector(".g-actions");
    act && (act.innerHTML = gActions(g));
    const dl = li.querySelector("dl.facts[data-facts]");
    if (dl) {
      const tmp = document.createElement("div");
      tmp.innerHTML = wt(g);
      const nd = tmp.querySelector("dl.facts"),
        cur = dl.querySelectorAll("dd"),
        nxt = nd ? nd.querySelectorAll("dd") : [];
      // Les lignes sont mises à jour sur place, pas remplacées : téléphone, horaires et site sont des zones « polite », un lecteur d'écran annonce
      // celles qui changent (et elles seules). Si la fiche n'a plus les mêmes lignes, on la remplace.
      if (cur.length === nxt.length) cur.forEach((dd, i) => dd.innerHTML !== nxt[i].innerHTML && (dd.innerHTML = nxt[i].innerHTML));
      else nd && dl.replaceWith(nd);
    }
  }
  // Appelé à l'ouverture d'une fiche : une seule demande par garage, une nouvelle tentative au plus si elle n'a pas pu se faire
  function mbxEnsure(g) {
    if (!mbxWant(g)) return;
    mbxEnr || (mbxEnr = createEnricher({ token: mbxCfg.token }));
    ((g.mbxBusy = !0), mbxRepaint(g));
    mbxEnr.lookup(g).then((r) => {
      g.mbxBusy = !1;
      if (!r) g.mbxTry = (g.mbxTry || 0) + 1;
      else {
        g.mbxDone = !0;
        const f = r.fields;
        (f.phone && (g.phone = f.phone), f.hours && (g.hours = f.hours), f.web && (g.web = f.web));
        g.mbx = Object.fromEntries(Object.keys(f).map((k) => [k, !0]));
      }
      mbxRepaint(g);
    });
  }
  // ----- Ville dans la puce distance (« 2,5 km · Bron ») -----
  // La ville dit de quel côté se trouve le garage. Elle vient, dans l'ordre : de la balise OpenStreetMap (addr:city,
  // contact:city, addr:suburb), de l'adresse déjà connue (ce qui suit le code postal : OpenStreetMap, contrôle technique,
  // SIRENE, adresse approchée), puis, pour un garage qui n'a ni l'un ni l'autre, de la commune de l'adresse la plus proche
  // (250 m au plus). Celle-ci est demandée au géocodeur inverse ci-dessus (même requête, même cache) pour les seules
  // cartes qui entrent à l'écran, 3 à la fois, 300 par visite au plus ; après 4 échecs de suite on s'arrête une minute
  // (réglage cityPause), puis on réessaie. Une commune ne change pas : une réponse en cache sert même périmée.
  // Interrupteur : window.JG_CITY_LOOKUP = false.
  const cityRange = 250,
    cityMax = 3,
    cityCap = 300,
    cityLook = window.JG_CITY_LOOKUP !== !1,
    cityQueue = [];
  let cityIO = null,
    cityRun = 0,
    cityAsked = 0,
    cityFails = 0,
    cityFailAt = 0;
  // disjoncteur : 4 échecs de suite arrêtent les demandes pendant cityPause ; ensuite on repart avec un compte à zéro
  function cityHalted() {
    if (cityFails < 4) return !1;
    if (Date.now() - cityFailAt < a.cityPause) return !0;
    return ((cityFails = 0), !1);
  }
  function cityOf(g) {
    if (!g) return "";
    if (g.city) return g.city;
    const fromAddr = cityFromAddr(g.addr);
    if (fromAddr) return fromAddr;
    if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) return "";
    const e = adMem[adId(g)];
    return (e && (e.c || cityFromAddr(e.a))) || "";
  }
  function distHtml(g) {
    const c = cityOf(g);
    return `${he("pin")}<span class="sr-only">à </span><span class="d-km">${y(E(g.dist))}</span>${c ? `<span class="sr-only">, </span><span class="d-sep" aria-hidden="true">·</span><span class="d-city">${y(c)}</span>` : ""}`;
  }
  function cityRepaint(g) {
    for (const n of document.querySelectorAll(`.dist[data-dist="${CSS.escape(g.id)}"]`)) n.innerHTML = distHtml(g);
  }
  // réponse absente, périmée, ou ancienne (sans commune) : à redemander
  const cityStale = (e) => !adFresh(e) || (!e.a && "string" != typeof e.c),
    cityNeeds = (g) =>
      !!g &&
      "osm" === g.src &&
      Number.isFinite(g.lat) &&
      Number.isFinite(g.lon) &&
      (g.cityFail || 0) < 2 &&
      !g.cityBusy &&
      !cityOf(g) &&
      cityStale(adMem[adId(g)]);
  function cityPump() {
    while (cityRun < cityMax && cityAsked < cityCap && cityQueue.length && !cityHalted()) {
      const g = cityQueue.shift();
      if (!cityNeeds(g)) continue;
      ((g.cityBusy = !0), cityRun++, cityAsked++);
      adFetch(g)
        .then((e) => {
          g.cityBusy = !1;
          if (e) cityFails = 0;
          else ((g.cityFail = (g.cityFail || 0) + 1), ++cityFails >= 4 && (cityFailAt = Date.now()));
          cityRepaint(g);
        })
        .catch(() => {})
        .then(() => S(80))
        .then(() => (cityRun--, cityPump()));
    }
  }
  // Appelé après chaque affichage de la liste : met en file les garages sans ville dont la carte est (ou arrive) à l'écran
  function cityWatch(items) {
    (cityIO && cityIO.disconnect(), (cityIO = null), (cityQueue.length = 0));
    if (!cityLook || cityHalted()) return;
    const todo = new Map(items.filter(cityNeeds).map((g) => [g.id, g]));
    if (!todo.size) return;
    const nodes = [...pe.list.querySelectorAll(".dist[data-dist]")].filter((n) => todo.has(n.dataset.dist)),
      take = (n) => {
        const g = todo.get(n.dataset.dist);
        g && cityQueue.push(g);
      };
    if ("function" != typeof window.IntersectionObserver) return (nodes.slice(0, 12).forEach(take), cityPump());
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) e.isIntersecting && (io.unobserve(e.target), take(e.target));
        cityPump();
      },
      { rootMargin: "160px 0px" },
    );
    ((cityIO = io), nodes.forEach((n) => io.observe(n)));
  }
  function Be(e) {
    const t = e.tags || {},
      a = $(e.lat ?? (e.center && e.center.lat)),
      n = $(e.lon ?? (e.center && e.center.lon));
    if (!isFinite(a) || !isFinite(n)) return null;
    const r = je(t),
      s = (function (e, t) {
        if ("car_repair" === e.shop || "tyres" === e.shop) return e.shop;
        if ("car_repair" === e.craft) return "car_repair";
        const a = k(e.name || "");
        return "car_parts" === e.shop && !t && /\bpneu/.test(a)
          ? "tyres"
          : t ||
              ze(e) ||
              /(^|;)\s*repair\b/.test(e.service || "") ||
              ("car_parts" === e.shop && /\b(garage|mecani\w*|centre auto)\b/.test(a))
            ? "car_repair"
            : "";
      })(t, r);
    if (!s) return null;
    const i = t.name || t.brand || t.operator,
      o = i ? q(i) : "tyres" === s ? "Spécialiste pneus (sans nom)" : "Garage (nom non renseigné)",
      l = [
        t["addr:housenumber"] || t["contact:housenumber"],
        t["addr:street"] || t["contact:street"] || t["addr:place"],
      ]
        .filter(Boolean)
        .join(" "),
      d = [
        t["addr:postcode"] || t["contact:postcode"],
        t["addr:city"] || t["contact:city"] || t["addr:suburb"],
      ]
        .filter(Boolean)
        .join(" "),
      gap = !(t["addr:street"] || t["contact:street"] || t["addr:place"] || t["addr:full"]),
      u = k(t.name || "");
    return adInit({
      id: `osm:${e.type}/${e.id}`,
      src: "osm",
      name: o,
      lat: a,
      lon: n,
      tags: t,
      shop: s,
      chain: r,
      addr: [l, d].filter(Boolean).join(", ") || q(t["addr:full"] || ""),
      city: cityTidy(t["addr:city"] || t["contact:city"] || t["addr:suburb"]),
      addrGap: gap,
      phone: [t.phone, t["contact:phone"], t.mobile, t["contact:mobile"], t["phone:mobile"]]
        .filter(Boolean)
        .join(";"),
      web: T(t.website || t["contact:website"] || ""),
      hours: t.opening_hours || "",
      dealer: !r && (c.test(t.brand || "") || c.test(t.name || "")),
      body:
        /carross/.test(u) &&
        !/meca|garage|pneu|entretien|reparation|service/.test(u.replace(/carross\w*/g, "")),
      osmUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`,
    });
  }
  const Ne = new Set([
    "garage",
    "garages",
    "auto",
    "autos",
    "automobile",
    "automobiles",
    "service",
    "services",
    "pneu",
    "pneus",
    "centre",
    "station",
    "sarl",
    "eurl",
    "sas",
    "sasu",
    "reparation",
    "mecanique",
    "entreprise",
  ]);
  function Ve(e) {
    return new Set(
      k(e)
        .split(/[^a-z0-9]+/)
        .filter((e) => e.length >= 4 && !Ne.has(e)),
    );
  }
  function Ge(e, t) {
    const a = Ve(t);
    for (const t of Ve(e)) if (a.has(t)) return !0;
    return !1;
  }
  const He = 20;
  function We(e, t) {
    const a = Array.isArray(e.matching_etablissements) ? e.matching_etablissements : [],
      n = je({ name: [e.nom_complet, e.nom_raison_sociale, e.sigle].filter(Boolean).join(" | ") }),
      r = je({
        name: a
          .flatMap((e) => (e.liste_enseignes || []).concat(e.nom_commercial || []))
          .filter(Boolean)
          .join(" | "),
      });
    for (const s of a) {
      if (s.etat_administratif && "A" !== s.etat_administratif) continue;
      const a = $(s.latitude),
        i = $(s.longitude);
      if (!isFinite(a) || !isFinite(i) || !s.siret || t.has(s.siret)) continue;
      const o = (Array.isArray(s.liste_enseignes) ? s.liste_enseignes : []).filter(Boolean),
        l = o.concat(s.nom_commercial || []).join(" | "),
        c = (l && je({ name: l })) || n || (l ? null : r),
        d = String(s.activite_principale || e.activite_principale || "");
      if (d && !d.startsWith("45.20") && ("45.32Z" !== d || !c)) continue;
      let u = q(
        o[0] ||
          s.nom_commercial ||
          e.nom_complet ||
          e.nom_raison_sociale ||
          "Atelier de réparation automobile",
      );
      (c && "glass" !== c.id && !k(u).includes(k(c.name)) && (u = `${c.name} (${u})`),
        t.set(s.siret, {
          id: "siret:" + s.siret,
          src: "sirene",
          name: u,
          lat: a,
          lon: i,
          addr: q(s.adresse || ""),
          phone: "",
          web: "",
          hours: "",
          chain: c,
          tags: {},
        }));
    }
  }
  async function Oe(e, t, n) {
    const r = new Map(),
      s = `https://recherche-entreprises.api.gouv.fr/near_point?lat=${e}&long=${t}&radius=${Math.min(n, 50)}&activite_principale=45.20A,45.32Z&per_page=25&limite_matching_etablissements=25&minimal=true&include=matching_etablissements`,
      i = async (e) => {
        for (let t = 0; ; t++) {
          const a = await F(`${s}&page=${e}`, {}, 15e3);
          if (!(429 === a.status && t < 3)) {
            if (!a.ok) throw new Error("sirene " + a.status);
            return a.json();
          }
          await S(1200 * (t + 1));
        }
      },
      o = await i(1);
    for (const e of o.results || []) We(e, r);
    const l = Math.max(1, $(o.total_pages) || 1),
      c = Math.min(l, He);
    let d = 2,
      u = 0;
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        for (; d <= c; ) {
          const e = d++;
          try {
            const t = await i(e);
            for (const e of t.results || []) We(e, r);
          } catch (e) {
            u++;
          }
          await S(a.sirenePace);
        }
      }),
    );
    const p = [];
    return (
      l > c &&
        p.push(
          `Registre SIRENE : ${25 * c} entreprises lues sur ${$(o.total_results) || 25 * l} dans la zone. Réduisez le rayon pour une liste complète.`,
        ),
      u &&
        p.push(
          `Registre SIRENE : ${V(u, "page n'a pas répondu", "pages n'ont pas répondu")}, la liste est incomplète.`,
        ),
      { items: [...r.values()], notes: p }
    );
  }
  const Qe = (e) =>
      /cyclo|moto|tricycle|quadri|cat[ée]gorie\s*l\b|\bl[1-7]e?\b|2\s*roues|3\s*roues|deux.roues/i.test(e),
    Ke = (e) => /particulier|\bvp\b|tourisme/i.test(e);
  function Ue(e, t) {
    let a = e.rows.filter((e) => !Qe(e.cat) && isFinite(e.price));
    const n = a.filter((e) => Ke(e.cat));
    n.length && (a = n);
    const r = a.filter((e) => k(e.energy) === k(t) || k(e.energy).includes(k(t))),
      s = r.length ? r : a;
    return s.length ? { ...s.reduce((e, t) => (t.price < e.price ? t : e)), matched: r.length > 0 } : null;
  }
  function Xe(e, t) {
    const a = e.tags || {},
      n = e.chain;
    if (n)
      return n.only
        ? n.only.includes(t.id)
          ? { lvl: "yes", why: "Au catalogue de l'enseigne" }
          : "glass" === n.id
            ? { lvl: "no" }
            : { lvl: "check", why: "Pas au catalogue national de l'enseigne : à vérifier" }
        : {
            lvl: "yes",
            why:
              "geo" === t.kind
                ? "Au catalogue de l'enseigne (banc de géométrie à confirmer)"
                : "Au catalogue de l'enseigne",
          };
    if ("sirene" === e.src) return { lvl: "check", why: "Registre SIRENE : prestations non renseignées" };
    const r = (t.osm || []).map((e) => a["service:vehicle:" + e]).filter(Boolean);
    return r.includes("yes")
      ? { lvl: "yes", why: "Indiqué sur OpenStreetMap" }
      : r.length && r.every((e) => "no" === e)
        ? { lvl: "no" }
        : e.body
          ? { lvl: "check", why: "Carrosserie : prestation à vérifier" }
          : e.dealer
            ? { lvl: "likely", why: "Atelier de marque : prestation probable" }
            : "geo" === t.kind
              ? "tyres" === e.shop
                ? { lvl: "likely", why: "Spécialiste pneus : prestation probable" }
                : { lvl: "check", why: "Banc de géométrie non renseigné : à vérifier" }
              : "tyres" === e.shop
                ? "tyre" === t.kind
                  ? { lvl: "likely", why: "Spécialiste pneus : prestation probable" }
                  : { lvl: "check", why: "Spécialiste pneus : mécanique à vérifier" }
                : { lvl: "likely", why: "Garage mécanique : prestation probable" };
  }
  // Les réparations : celles de ce navigateur et, si une API est configurée, celles de la zone (shared: true). Le tableau Ze
  // est vivant (jamais remplacé) ; tout ce qui s'écrit passe par RS (modules/repair-store.js).
  const RS = createStore({ apiBase: apiBase(), storage: jsonStorage() }),
    Ye = RS.storageWorks(),
    Ze = RS.rows();
  document.body.dataset.store = RS.mode; // « local » ou « remote » : certains textes en dépendent (CSS [data-store-only])
  let quiet = false; // vrai pendant une action de la page : elle réaffiche elle-même, les événements du magasin ne doublent pas
  const act = (fn) => {
    quiet = true;
    try {
      return fn();
    } finally {
      quiet = false;
    }
  };
  function tt(e) {
    return k(e)
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }
  function at(e, t) {
    if (tt(e) && tt(e) === tt(t)) return !0;
    const a = Ve(e),
      n = Ve(t);
    for (const e of a) if (n.has(e)) return !0;
    return !1;
  }
  function nt(e, t) {
    return (
      e.garageId === t.id ||
      // une réparation d'un autre visiteur est rattachée à un garage identifié (OpenStreetMap, SIRET) par cet identifiant seul
      (!(e.shared && !e.garageId.startsWith("custom:")) &&
        (Number.isFinite(e.lat) && Number.isFinite(e.lon)
          ? _(e, t) < 0.15 && at(e.garageName, t.name)
          : tt(e.garageName) === tt(t.name)))
    );
  }
  function rt(e, t) {
    return Ze.filter((a) => (!t || a.serviceId === t) && nt(a, e));
  }
  function st(e, t, a) {
    const n = (function (e, t) {
        return (e.chain && (u[t.id] || []).find((t) => t.c === e.chain.id)) || null;
      })(e, t),
      r = a ? a.filter((e) => e.serviceId === t.id) : rt(e, t.id);
    if (r.length) {
      const e = r.reduce((e, t) => (t.date > e.date ? t : e));
      return {
        kind: "declared",
        amount: N(r.map((e) => e.price)),
        n: r.length,
        last: e.date,
        ref: n,
        mine: r,
      };
    }
    return n
      ? { kind: "chain", amount: n.p, from: !!n.from, approx: !!n.approx, partial: !!n.partial, ref: n }
      : e.chain
        ? { kind: "center" }
        : { kind: "none" };
  }
  // ----- Échelle de prix : où se situent les réparations d'un garage, avec deux repères nommés et chiffrés ------------
  // Les points sont les réparations déclarées chez ce garage pour la prestation, placés sur l'étendue de tous les prix
  // connus (réparations déclarées + prix des enseignes). Deux repères, écrits en toutes lettres au-dessus de l'échelle :
  // la médiane des enseignes (▼) et la médiane de ce garage (▲), avec l'écart entre les deux. Sans prix d'enseigne pour
  // la prestation, seule la médiane du garage est repérée.
  // e : réparations déclarées chez ce garage pour la prestation ; t : id de la prestation ; a : nommer la prestation.
  function it(e, t, a) {
    if (!e.length) return "";
    const n = (u[t] || []).filter((e) => !e.partial).map((e) => e.p),
      r = Ze.filter((e) => e.serviceId === t)
        .map((e) => e.price)
        .concat(n),
      s = Math.min(...r),
      i = Math.max(...r),
      o = i - s,
      l = (e) => (o > 0 ? Math.max(0, Math.min(100, ((e - s) / o) * 100)).toFixed(1) : "50"),
      c = n.length ? N(n) : NaN,
      ref = Number.isFinite(c),
      d = e.map(Y).sort((e, t) => e.month.localeCompare(t.month)),
      p = d.map((e) => e.price),
      m = N(p),
      gap = ref ? (m - c) / c : 0,
      kind = Math.abs(gap) < 0.05 ? "eq" : gap < 0 ? "low" : "high",
      g = d
        .map(
          (e) =>
            `<span class="scale-dot" style="left:${l(e.price)}%" title="${y([C(e.price), vehLabel(e) || "modèle non renseigné", G(e.month)].join(" · "))}"></span>`,
        )
        .join("");
    let h =
      1 === e.length
        ? `1 réparation déclarée, en ${G(d[0].month)}`
        : `${e.length} réparations déclarées, de ${C(Math.min(...p))} à ${C(Math.max(...p))}`;
    h += 1 === r.length ? ". Les prochaines déclarations compléteront l'échelle." : ".";
    return `<div class="scale${ref ? "" : " no-ref"}">
      <div class="scale-head"><span class="label">Échelle de prix${a ? ` <small>· ${y(j(t))}</small>` : ""}</span>${ref ? `<span class="delta is-${kind}">${"eq" === kind ? "Au niveau des enseignes" : `${Math.round(100 * Math.abs(gap))} % ${gap < 0 ? "sous les enseignes" : "au-dessus des enseignes"}`}</span>` : ""}</div>
      <div class="scale-cmp">
        ${ref ? `<div class="cmp is-ref"><span class="cmp-k"><i class="k-ref" aria-hidden="true"></i>Médiane des enseignes</span><b class="cmp-v">${C(c)}</b></div>` : ""}
        <div class="cmp is-me"><span class="cmp-k"><i class="k-me" aria-hidden="true"></i>Médiane de ce garage</span><b class="cmp-v">${C(m)}</b></div>
      </div>
      <div class="scale-bar" aria-hidden="true">${ref ? `<span class="scale-ref" style="left:${l(c)}%"></span>` : ""}${g}<span class="scale-med" style="left:${l(m)}%"></span></div>
      ${o > 0 ? `<div class="scale-ends" aria-hidden="true"><span>${C(s)} · moins cher</span><span>plus cher · ${C(i)}</span></div>` : ""}
      <p class="scale-text">${y(h)}</p>
    </div>`;
  }
  const ot = new Set();
  async function lt(e) {
    if (me.busy) return;
    const s = fe();
    if (
      (Ce(),
      "unknown" === me.mode && me.probe && (await me.probe),
      "preview" === me.mode && (await (me.probe = we())),
      "preview" !== me.mode)
    ) {
      ct(!0);
      try {
        let l = me.place;
        if (!l) {
          const e = pe.address.value.trim();
          if (!e)
            return (dt("Indiquez une adresse, une ville ou un code postal.", "err"), void pe.address.focus());
          let t;
          dt("Recherche de l'adresse…");
          try {
            t = await $e(e, 1, !1);
          } catch (e) {
            return void ut(0, "adresse");
          }
          if (!t.length)
            return void dt(
              "Adresse introuvable. Essayez avec le code postal, par exemple « 64100 Bayonne ».",
              "err",
            );
          ((l = me.place = t[0]), (pe.address.value = l.label), na());
        }
        const c = +pe.radius.value;
        // réparations déclarées de la zone : chargées pendant la recherche des garages, pas après (pas de liste qui se réordonne)
        const repairsLoad = "ct" === s.kind ? null : RS.load({ lat: l.lat, lon: l.lon, km: c }).catch(() => ({}));
        if ((pt(), "ct" === s.kind)) {
          let e;
          dt(`Chargement des prix officiels du contrôle technique dans un rayon de ${c} km…`);
          try {
            e = await (async function (e, t) {
              const a = t / 111.2,
                n = t / (111.2 * Math.cos((e.lat * Math.PI) / 180)),
                r = `latitude >= ${(e.lat - a).toFixed(5)} and latitude <= ${(e.lat + a).toFixed(5)} and longitude >= ${(e.lon - n).toFixed(5)} and longitude <= ${(e.lon + n).toFixed(5)}`,
                s = [
                  { where: r, select: !0 },
                  { where: r, select: !1 },
                ];
              e.dep && s.push({ where: `cct_departement = "${e.dep}"`, select: !1 });
              let i = 0,
                o = null;
              for (let e = 0; e < s.length; e++) {
                const t = new URLSearchParams({ where: s[e].where });
                s[e].select &&
                  t.set(
                    "select",
                    "cct_siret,cct_denomination,cct_adresse,cct_code_postal,cct_commune,cct_tel,cct_url,latitude,longitude,cat_vehicule_id,cat_vehicule_libelle,cat_energie_id,cat_energie_libelle,prix_visite,prix_contre_visite_mini,prix_contre_visite_maxi,date_application_visite",
                  );
                const a = await F(
                  `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-controle-technique/exports/json?${t}`,
                  {},
                  45e3,
                );
                if (!a.ok) {
                  i = a.status;
                  continue;
                }
                const n = await a.json();
                if (Array.isArray(n) && n.length) return n;
                Array.isArray(n) && (o = n);
              }
              if (o) return o;
              throw new Error("ct " + i);
            })(l, c);
          } catch (e) {
            return void ut(0, "ct");
          }
          ((me.raw = (function (e) {
            const t = new Map();
            for (const a of e) {
              const e = $(a.latitude),
                n = $(a.longitude);
              if (!isFinite(e) || !isFinite(n)) continue;
              const r = a.cct_siret || `${a.cct_denomination}|${a.cct_adresse}`;
              let s = t.get(r);
              if (!s) {
                const i = q(a.cct_denomination || "Centre de contrôle technique"),
                  o = d.find(([, e]) => e.test(i));
                ((s = {
                  id: "ct:" + r,
                  src: "ct",
                  name: i,
                  network: o ? o[0] : "",
                  lat: e,
                  lon: n,
                  addr: q(
                    [a.cct_adresse, [a.cct_code_postal, a.cct_commune].filter(Boolean).join(" ")]
                      .filter(Boolean)
                      .join(", "),
                  ),
                  phone: a.cct_tel || "",
                  web: T(a.cct_url),
                  hours: "",
                  rows: [],
                }),
                  t.set(r, s));
              }
              s.rows.push({
                cat: String(a.cat_vehicule_libelle || ""),
                energy: String(a.cat_energie_libelle || ""),
                price: $(a.prix_visite),
                cvMin: $(a.prix_contre_visite_mini),
                cvMax: $(a.prix_contre_visite_maxi),
                date: a.date_application_visite || "",
              });
            }
            return [...t.values()];
          })(e)),
            (me.kind = "ct"),
            (function () {
              const e = (function () {
                const e = new Map();
                for (const t of me.raw)
                  for (const a of t.rows) a.energy && !Qe(a.cat) && e.set(k(a.energy), a.energy);
                return [...e.values()].sort((e, t) => e.localeCompare(t, "fr"));
              })();
              if (!e.length) return;
              const t = k(pe.energy.value);
              pe.energy.innerHTML = e.map((e) => `<option>${y(e)}</option>`).join("");
              const a = e.find((e) => k(e) === t) || e.find((e) => /essence/i.test(e)) || e[0];
              pe.energy.value = a;
            })());
        } else {
          dt(`Recherche des garages dans un rayon de ${c} km…`);
          const r = Math.round(1e3 * c);
          let s = null,
            d = null;
          try {
            const n = await (function (e, n, r, s, i) {
              const o = i ? null : Ie(e, n, r);
              if (o) return Promise.resolve({ elements: o.els, server: "cache", t: o.t });
              const l = overpassQuery(e, n, r),
                c = t.filter((t) => !t.metro || Te(e, n)),
                d = c.map((e) => ({ name: e.name, status: "non sollicité" })),
                u = c.map(() => 0),
                p = [];
              return new Promise((t, i) => {
                let o = 0,
                  m = 0,
                  g = !1,
                  h = null;
                const f = () => {
                    if ((clearTimeout(h), g || o >= c.length)) return;
                    const e = o++;
                    (s && s(e), b(e), o < c.length && (h = setTimeout(f, a.stagger)));
                  },
                  v = (e, t, n) => {
                    if (g) "en cours" === d[e].status && (d[e].status = "annulé");
                    else {
                      if (((d[e].status = t), n && u[e] < 2))
                        return (
                          setTimeout(() => {
                            g || b(e);
                          }, a.retry),
                          void f()
                        );
                      if ((m++, m >= c.length)) {
                        const e = new Error("overpass");
                        ((e.report = d), i(e));
                      } else f();
                    }
                  },
                  b = (s) => {
                    (u[s]++, (d[s].status = "en cours"));
                    const i = new AbortController();
                    p.push(i);
                    let o = !1;
                    const m = setTimeout(() => {
                      ((o = !0), i.abort());
                    }, a.osmTimeout);
                    fetch(`${c[s].url}?data=${encodeURIComponent(l)}`, { signal: i.signal })
                      .then(async (a) => {
                        if (!a.ok)
                          return v(
                            s,
                            429 === a.status
                              ? "saturé (429)"
                              : 504 === a.status
                                ? "délai serveur dépassé (504)"
                                : `erreur ${a.status}`,
                            429 === a.status || a.status >= 500,
                          );
                        let o;
                        try {
                          o = await a.json();
                        } catch (e) {
                          return v(s, "réponse illisible", !1);
                        }
                        return Array.isArray(o.elements)
                          ? o.remark && /error|timed out|out of memory/i.test(o.remark)
                            ? v(s, "requête interrompue par le serveur", !0)
                            : void (
                                g ||
                                ((g = !0),
                                clearTimeout(h),
                                (d[s].status = "ok"),
                                p.forEach((e) => {
                                  e !== i && e.abort();
                                }),
                                (function (e, t, a, n) {
                                  const r = n.map((e) => {
                                    const t = {};
                                    for (const a in e.tags || {}) qe.test(a) && (t[a] = e.tags[a]);
                                    return {
                                      type: e.type,
                                      id: e.id,
                                      lat: e.lat,
                                      lon: e.lon,
                                      center: e.center,
                                      tags: t,
                                    };
                                  });
                                  if (JSON.stringify(r).length > 15e5) return;
                                  const s = P.get(Re, {}) || {},
                                    i = `${e.toFixed(4)},${t.toFixed(4)}`;
                                  s[`${i},${a}`] = { at: i, m: a, t: Date.now(), els: r };
                                  const o = Object.keys(s).sort((e, t) => s[t].t - s[e].t);
                                  for (const e of o.slice(6)) delete s[e];
                                  P.set(Re, s);
                                })(e, n, r, o.elements),
                                t({ elements: o.elements, server: c[s].name }))
                              )
                          : v(s, "réponse illisible", !1);
                      })
                      .catch(() =>
                        v(
                          s,
                          o
                            ? `pas de réponse en ${Math.round(a.osmTimeout / 1e3)} s`
                            : "connexion impossible",
                          !o,
                        ),
                      )
                      .finally(() => clearTimeout(m));
                  };
                f();
              });
            })(
              l.lat,
              l.lon,
              r,
              (e) => {
                e > 0 && dt("Le serveur principal tarde à répondre. Essai d'un serveur de secours…");
              },
              !0 === e,
            );
            ((s = n.elements.map(Be).filter(Boolean)), (me.cachedAt = "cache" === n.server ? n.t : 0));
          } catch (e) {
            d = e;
          }
          if (!s) {
            const e = Ie(l.lat, l.lon, r, 30 * n);
            e && ((s = e.els.map(Be).filter(Boolean)), (me.cachedAt = e.t));
          }
          if (s && pe.sirene.checked) {
            dt("Ajout des ateliers du registre SIRENE…");
            try {
              const e = await Oe(l.lat, l.lon, c);
              ((s = s.concat(
                ((i = e.items),
                (o = s),
                i.filter((e) => {
                  const t = o.find((t) => {
                    const a = _(e, t);
                    return a < 0.04 || (a < 0.15 && Ge(e.name, t.name));
                  });
                  return (
                    !t ||
                    (e.chain &&
                      !e.chain.only &&
                      !t.chain &&
                      Ge(e.name, t.name) &&
                      ((t.chain = e.chain), (t.dealer = !1)),
                    !1)
                  );
                })),
              )),
                me.notes.push(...e.notes));
            } catch (e) {
              me.notes.push("Le registre SIRENE n'a pas répondu : aucun atelier n'est ajouté à cette liste.");
            }
          }
          if (!s) {
            let e;
            dt("La base des garages ne répond pas. Recherche dans le registre des entreprises (SIRENE)…");
            try {
              e = await Oe(l.lat, l.lon, c);
            } catch (e) {
              return void ut(0, "osm", De(d));
            }
            ((s = e.items), me.notes.push(...e.notes));
          }
          ((me.raw = s), (me.garages = s), (me.kind = "osm"));
        }
        repairsLoad && (await Promise.race([repairsLoad, new Promise((done) => setTimeout(done, 2500))])); // jamais plus de 2,5 s d'attente
        ((me.fetchedKm = c), (me.shown = r), dt(""), Pe(!0), ht());
      } finally {
        ct(!1);
      }
      var i, o;
    } else
      dt(
        "Recherche impossible : la page ne peut pas joindre les services publics. Dans l'aperçu claude.ai, c'est normal ; ouvrez l'app dans un navigateur ou en ligne.",
        "err",
      );
  }
  function ct(e) {
    ((me.busy = e),
      document.body.classList.toggle("is-searching", e),
      (pe.go.disabled = e),
      pe.go.setAttribute("aria-busy", String(e)),
      e ? (pe.goLabel.textContent = "Recherche…") : ve());
  }
  // Pendant une recherche l'encart d'état montre la phrase d'attente puis l'étape en cours ; le pictogramme (rond-point et
  // voiture, le même que sur la carte) n'apparaît que sur mobile, où la carte est cachée (CSS « Chargement »). La phrase
  // est décorative : cachée aux lecteurs d'écran, pour que la zone vivante (#results) ne la relise pas à chaque étape.
  const waitQuote = "Votre titine est comme vous, elle n'aime pas qu'on lui cache des choses",
    waitSvg = `<svg class="wait-loader" viewBox="-100 -100 200 200" aria-hidden="true" focusable="false"><g class="ld"><circle class="ld-asphalt" r="75" fill="none" stroke-width="34" /> <circle class="ld-edge" r="91.2" fill="none" stroke-width="1.6" /> <circle class="ld-edge" r="58.8" fill="none" stroke-width="1.6" /> <circle class="ld-dash" r="75" fill="none" stroke-width="2.6" stroke-dasharray="8.4 8.43" /> <circle class="ld-island" r="58" /><circle class="ld-pin" r="9" /><g class="ld-orbit"><g class="ld-car" transform="translate(0 -84) scale(1.1)"><path class="ld-body" d="M-14 3.2V-.4Q-14-1.6-12.6-2L-7.2-2.9-3.4-6.4Q-3-6.8-2.4-6.8H5.6Q6.4-6.8 6.9-6.2L10.4-2.4 12.6-2.1Q14-1.9 14-.5V3.2Z" /><path class="ld-glass" d="M-6.4-2.6-3.2-5.7H5.5L9.1-2.6Z" /><circle class="ld-tyre" cx="-8.2" cy="3.2" r="3.2" /><circle class="ld-tyre" cx="8.6" cy="3.2" r="3.2" /><circle class="ld-hub" cx="-8.2" cy="3.2" r="1.3" /><circle class="ld-hub" cx="8.6" cy="3.2" r="1.3" /><circle class="ld-hub" cx="-13.2" cy=".8" r="1.1" /></g></g></g></svg>`;
  function dt(e, t, a, n) {
    const wait = !!e && !t && me.busy;
    ((pe.status.className = "status" + ("err" === t ? " err" : "") + (wait ? " is-wait" : "")),
      (pe.status.innerHTML = e
        ? (wait
            ? waitSvg +
              `<span class="wait-quote" aria-hidden="true">${y(waitQuote)}</span><span class="wait-step">${y(e)}</span>`
            : y(e)) +
          (n ? `<details class="detail"><summary>Détails techniques</summary>${y(n)}</details>` : "") +
          (a ? '<br><button type="button" class="ghost" id="retryBtn">Réessayer</button>' : "")
        : ""));
    const r = w("#retryBtn");
    r && r.addEventListener("click", lt);
  }
  function ut(e, t, a) {
    const n = !navigator.onLine;
    dt(
      `${{ adresse: "Le service d'adresses de l'IGN ne répond pas.", osm: "Ni la base des garages ni le registre des entreprises ne répondent.", ct: "Les prix officiels du contrôle technique ne répondent pas. Vous pouvez les consulter sur prix.conso.gouv.fr." }[t]} ${n ? "Vous semblez hors connexion. " : ""}Réessayez dans une minute.`,
      "err",
      !0,
      a,
    );
  }
  function pt() {
    ((me.raw = []),
      (me.view = []),
      (me.cachedAt = 0),
      (me.mapKey = ""),
      (me.notes = []),
      me.openIds.clear(),
      sl(null),
      (pe.summary.hidden = !0),
      (pe.toolbar.hidden = !0),
      (pe.mapPane.hidden = !0),
      (pe.mapFab.hidden = !0),
      (pe.moreBtn.hidden = !0),
      (pe.osmNote.hidden = !0),
      "map" === me.viewMode && St("list"),
      (pe.list.innerHTML = ""),
      be(),
      renderRepairNote());
  }
  pe.form.addEventListener("submit", (e) => {
    (e.preventDefault(), lt());
  });
  // État du service des réparations partagées (mode distant) : copie de secours, indisponible, envois en attente
  function renderRepairNote() {
    const st = RS.status(),
      parts = [];
    if ("remote" === st.mode && "ct" !== me.kind && me.raw.length) {
      if ("down" === st.api)
        parts.push("Les réparations déclarées par les automobilistes sont momentanément indisponibles : seuls les prix des enseignes et vos propres déclarations sont affichés.");
      else if ("stale" === st.api)
        parts.push("Le service des réparations déclarées ne répond pas : la dernière copie enregistrée sur cet appareil est affichée.");
    }
    if (st.pending)
      parts.push(`${V(st.pending, "réparation", "réparations")} en attente d'envoi : ${st.pending > 1 ? "elles partiront" : "elle partira"} dès que le service répondra.`);
    pe.repairNote.textContent = parts.join(" ");
    pe.repairNote.hidden = !parts.length;
  }
  const mt = (e) => e.price && isFinite(e.price.amount) && !e.price.partial;
  function gt(e) {
    me.filter = e;
    const t = e.startsWith("chain:") ? "chains" : e;
    for (const e of pe.toolbar.querySelectorAll("[data-filter]"))
      e.setAttribute("aria-pressed", String(e.dataset.filter === t));
  }
  function ht() {
    const e = fe(),
      t = "ct" === me.kind,
      a = pe.toolbar.querySelector('[data-filter="promo"]'),
      n = pe.toolbar.querySelector('[data-sort="note"]');
    if (
      ((a.hidden = t),
      (n.hidden = t),
      t && ("promo" === me.filter || me.filter.startsWith("chain:")) && gt("all"),
      t && "note" === me.sort)
    ) {
      me.sort = "price";
      for (const e of pe.toolbar.querySelectorAll("[data-sort]"))
        e.setAttribute("aria-pressed", String("price" === e.dataset.sort));
    }
    const r = (function () {
      const e = fe(),
        t = +pe.radius.value,
        a = me.place,
        n = [];
      for (const r of me.raw) {
        const s = _(a, r);
        if (!(s > t + 0.05))
          if ("ct" === me.kind) {
            const e = Ue(r, pe.energy.value);
            n.push({
              ...r,
              dist: s,
              ct: e,
              price: e ? { kind: "official", amount: e.price } : { kind: "none" },
            });
          } else {
            const t = Xe(r, e);
            if ("no" === t.lvl) continue;
            const a = rt(r, null);
            n.push({
              ...r,
              dist: s,
              offer: t,
              price: st(r, e, a),
              promos: r.chain ? oe(r.chain.id, e.id) : [],
              rating: ae(a),
              mine: a,
            });
          }
      }
      return n;
    })();
    (me.filter.startsWith("chain:") &&
      !r.some((e) => e.chain && "chain:" + e.chain.id === me.filter) &&
      gt("all"),
      (me.view = (function (e) {
        const t = e.slice();
        if ("dist" === me.sort) return t.sort((e, t) => e.dist - t.dist);
        if ("note" === me.sort) {
          const e = (e) => (e.rating ? e.rating.avg : -1);
          return t.sort(
            (t, a) =>
              e(a) - e(t) || (a.rating ? a.rating.n : 0) - (t.rating ? t.rating.n : 0) || t.dist - a.dist,
          );
        }
        const a = (e) => (mt(e) ? 0 : e.price && isFinite(e.price.amount) ? 1 : 2);
        return t.sort(
          (e, t) => a(e) - a(t) || (a(e) < 2 ? e.price.amount - t.price.amount : 0) || e.dist - t.dist,
        );
      })(
        (function (e) {
          switch (me.filter) {
            case "priced":
              return e.filter(mt);
            case "chains":
              return e.filter((e) => e.chain || e.network);
            case "indep":
              return e.filter((e) => !e.chain && !e.network);
            case "promo":
              return e.filter((e) => le(e.promos));
            default:
              return me.filter.startsWith("chain:")
                ? e.filter((e) => e.chain && "chain:" + e.chain.id === me.filter)
                : e;
          }
        })(r),
      )),
      (pe.teaser.hidden = !0),
      (function (e, t) {
        const a = +pe.radius.value,
          n = e.filter(mt);
        let r = "";
        if ("ct" === me.kind) {
          if (
            ((r += `<p class="big">${e.length} centre${e.length > 1 ? "s" : ""} de contrôle technique à moins de ${a} km</p>`),
            n.length)
          ) {
            const e = n.map((e) => e.price.amount),
              t = n.reduce((e, t) => (t.price.amount < e.price.amount ? t : e));
            r += `<p class="best">Visite ${y(pe.energy.value.toLowerCase())} : de <b>${C(Math.min(...e))}</b> à <b>${C(Math.max(...e))}</b>. Le moins cher : <b>${y(t.name)}</b>, à ${E(t.dist)}.</p>`;
          }
        } else {
          if (
            ((r += `<p class="big">${e.length} garage${e.length > 1 ? "s" : ""} à moins de ${a} km</p>`),
            n.length)
          ) {
            const e = n.reduce((e, t) => (t.price.amount < e.price.amount ? t : e)),
              t = n.filter((e) => "declared" === e.price.kind).length;
            r += `<p class="best">${n.length} avec un prix${t ? ` (dont ${t} déclaré${t > 1 ? "s" : ""} par ${"remote" === RS.mode ? "des automobilistes" : "vous"})` : " affiché"}. Le moins cher : <b>${y(e.name)}</b>, à ${E(e.dist)}, <b>${C(e.price.amount)}</b>.</p>`;
          } else
            e.length
              ? (r += `<p class="best">${(u[t.id] || []).length ? "Aucun centre d'enseigne à prix public dans cette zone." : "Aucun prix public pour cette prestation."} Demandez des devis, puis déclarez le prix payé avec « Ajouter une réparation » pour construire l'échelle de prix de chaque garage.</p>`)
              : (r +=
                  '<p class="best">Aucun garage référencé dans cette zone. Élargissez le rayon ou cochez le registre SIRENE dans les options.</p>');
          const i = [...new Set(e.filter((e) => le(e.promos)).map((e) => e.chain.name))];
          i.length &&
            (r += `<p class="best"><span class="tag promo">${se}Promo</span> ${i.length > 1 ? "Promotions en cours" : "Promotion en cours"} chez ${y(((s = i), s.length < 2 ? s.join("") : s.slice(0, -1).join(", ") + " et " + s[s.length - 1]))}.</p>`);
          const o = new Map();
          for (const t of e)
            if (t.chain) {
              const e = o.get(t.chain.id) || { c: t.chain, n: 0 };
              (e.n++, o.set(t.chain.id, e));
            }
          o.size &&
            (r += `<div class="chain-line"><span class="lbl-s" id="chainLbl">Enseignes dans la zone</span><div class="chips" role="group" aria-labelledby="chainLbl">${[
              ...o.values(),
            ]
              .sort((e, t) => t.n - e.n || e.c.name.localeCompare(t.c.name, "fr"))
              .map(
                (e) =>
                  `<button type="button" class="chip sm" data-chain="${e.c.id}" aria-pressed="${me.filter === "chain:" + e.c.id}">${y(e.c.name)} <span class="n">${e.n}</span><span class="sr-only"> ${e.n > 1 ? "centres" : "centre"}</span></button>`,
              )
              .join("")}</div></div>`);
        }
        var s;
        for (const e of me.notes) r += `<p class="hint">${y(e)}</p>`;
        if (me.cachedAt) {
          const e = new Date(me.cachedAt);
          r += `<p class="hint">Liste des garages enregistrée le ${y(B(`${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, "0")}-${String(e.getDate()).padStart(2, "0")}`))} à ${String(e.getHours()).padStart(2, "0")} h ${String(e.getMinutes()).padStart(2, "0")}. <button type="button" class="linkish" id="refreshBtn">Actualiser</button></p>`;
        }
        ((pe.summary.innerHTML = r), (pe.summary.hidden = !1));
        const i = w("#refreshBtn");
        i && i.addEventListener("click", () => lt(!0));
      })(r, e),
      (pe.toolbar.hidden = 0 === r.length),
      (pe.osmNote.hidden = t || !me.view.length),
      (pe.mapPane.hidden = "preview" === me.mode || !me.place || !r.length),
      (pe.mapFab.hidden = pe.mapPane.hidden),
      me.sel && !me.view.some((e) => e.id === me.sel) && sl(null),
      Et(),
      ft(),
      renderRepairNote());
  }
  function ft() {
    const e = fe(),
      t = me.view.slice(0, me.shown);
    pe.list.innerHTML = t
      .map((t, a) =>
        "ct" === me.kind
          ? (function (e, t) {
              const a = e.ct,
                n = a
                  ? `<span class="amount"><span class="num">${C(a.price)}</span></span><span class="tag ok">Prix officiel</span>`
                  : '<span class="no-price">Prix non déclaré</span>';
              return bt(e, t, e.network || "Contrôle technique", "", n, { details: () => $t(e) });
            })(t, a)
          : (function (e, t, a) {
              const n = e.price,
                r = e.promos || [],
                s = kd(e),
                i = a.unit ? `<span class="unit">${y(a.unit)}</span>` : "";
              let o;
              o =
                "declared" === n.kind
                  ? `<span class="amount"><span class="num">${C(n.amount)}</span>${i}</span><span class="tag info">Prix déclaré</span>`
                  : "chain" === n.kind
                    ? `<span class="amount">${n.approx ? '<span class="from">env.</span>' : ""}<span class="num">${C(n.amount)}</span>${i}</span><span class="tag ${n.partial ? "warn" : "ok"}">${n.partial ? "Pièces en plus" : "Prix enseigne"}</span>`
                    : "center" === n.kind
                      ? '<span class="no-price">Tarif fixé par le centre</span>'
                      : '<span class="no-price">Prix non publié</span>';
              const l = e.rating,
                c = l
                  ? `<span class="rating">${re(l.avg)}<span><b>${te(l.avg)}</b>/5 · ${V(l.n, "note", "notes")}</span></span>`
                  : "",
                d = r.filter((e) => "active" === e.st),
                u = d.length
                  ? `<p class="g-promo"><span class="tag promo">${se}Promo</span><b>${y(d[0].label)}</b><span>${y(de(d[0]))}${d.length > 1 ? ` · ${V(d.length - 1, "autre offre", "autres offres")} dans les détails` : ""}</span></p>`
                  : "";
              return bt(e, t, s, c, o, {
                avail: `<p class="svc lvl-${e.offer.lvl}"><span class="dot" aria-hidden="true"></span><span>${y(e.offer.why)}</span></p>`,
                strip: u,
                details: () => yt(e, a),
              });
            })(t, a, e),
      )
      .join("");
    const a = me.view.length - t.length;
    ((pe.moreBtn.hidden = a <= 0),
      (pe.moreBtn.textContent = `Afficher ${Math.min(a, r)} de plus (${a} restant${a > 1 ? "s" : ""})`),
      !me.view.length &&
        me.raw.length &&
        (pe.list.innerHTML = '<li class="status">Aucun résultat avec ce filtre.</li>'),
      cityWatch(t));
  }
  const vt = (e) => (phoneList(e)[0] || {}).text || "";
  // ----- Enseignes : monogramme de marque, puis vrai logo dès qu'on le trouve --------------------------
  // Toute enseigne a toujours un avatar « de marque » : monogramme coloré (teintes propres à l'interface, pas les
  // couleurs officielles). Le logo le remplace dès qu'il est trouvé, dans cet ordre :
  //   1. Wikidata : icône (P8972) ou logo (P154) de l'enseigne, image de Wikimedia Commons ;
  //   2. à défaut, l'icône du site officiel (apple-touch-icon, favicon.ico), acceptée seulement si elle fait au moins
  //      32 px. Le site est celui des prix et promotions de la page, sinon celui de la table logoDom, sinon celui de
  //      Wikidata (P856). Ce palier ne dépend pas de Wikidata : il démarre au bout de 2,5 s au plus, réponse ou non.
  // Réponse gardée 30 jours, jamais bloquant. Imposer un logo : window.JG_LOGOS = { norauto: "https://…/logo.png" }.
  // Ne pas contacter les sites des enseignes : window.JG_SITE_ICONS = false. Ne pas interroger Wikidata :
  // window.JG_WIKIDATA = false. Diagnostic : jgLogos().
  const logoKey = "jg.logos.v2",
    logoBrand = {
      norauto: ["#e2231a", "N"],
      feuvert: ["#00853f", "FV"],
      speedy: ["#ffd100", "S"],
      midas: ["#c8102e", "M"],
      roady: ["#f26522", "R"],
      euromaster: ["#0057b8", "E"],
      points: ["#004a99", "PS"],
      firststop: ["#f2a900", "FS"],
      vulco: ["#00778a", "V"],
      profilplus: ["#0072ce", "P+"],
      siligom: ["#6d28d9", "SG"],
      eurotyre: ["#a61c2b", "ET"],
      bestdrive: ["#2f3a4a", "BD"],
      driver: ["#1396d8", "DC"],
      eleclerc: ["#0066b3", "L"],
      cartercash: ["#e8b100", "CC"],
      eurorepar: ["#1e5bb8", "ER"],
      motrio: ["#d97706", "MO"],
      ad: ["#d1001c", "AD"],
      bosch: ["#e20015", "B"],
      topgarage: ["#e8590c", "TG"],
      precisium: ["#0f766e", "PR"],
      delko: ["#4338ca", "D"],
      autoprimo: ["#db2777", "AP"],
      avatacar: ["#059669", "AV"],
      glass: ["#9b1c31", "CG"],
    },
    // réseaux de contrôle technique (clé : nom sans accents ni ponctuation)
    ctBrand = {
      autosur: ["#1d4ed8", "A"],
      dekra: ["#15803d", "D"],
      securitest: ["#b91c1c", "S"],
      autovision: ["#0e7490", "AV"],
      norisko: ["#7c3aed", "N"],
      verifauto: ["#b45309", "V"],
      autosecurite: ["#0369a1", "AS"],
      controleauto: ["#4d7c0f", "CA"],
    },
    // sites officiels des enseignes sans site dans les données de la page, relevés par recherche web le 1er octobre 2026
    // (à revérifier avec jgLogos() si un logo manque ; Driver Center : aucun site français trouvé)
    logoDom = {
      points: "https://www.points.fr",
      firststop: "https://www.firststop.fr",
      vulco: "https://www.vulco.fr",
      profilplus: "https://www.profilplus.fr",
      siligom: "https://www.siligom.fr",
      eurotyre: "https://www.eurotyre.fr",
      bestdrive: "https://www.bestdrive.fr",
      eleclerc: "https://www.auto.leclerc",
      cartercash: "https://www.carter-cash.com",
      eurorepar: "https://www.eurorepar.fr",
      motrio: "https://www.motrio.fr",
      ad: "https://www.ad.fr",
      bosch: "https://www.boschcarservice.com",
      topgarage: "https://www.top-garage.fr",
      precisium: "https://www.precisium.fr",
      delko: "https://www.delko.fr",
      autoprimo: "https://www.autoprimo.com",
      avatacar: "https://www.avatacar.com",
      glass: "https://www.carglass.fr",
    },
    logoMap = {},
    logoSite = {},
    logoWork = {},
    logoGot = {},
    logoOwn = {},
    logoTried = new Set(),
    logoWant = new Set(),
    logoWide = new Set(),
    logoBusy = new Set(),
    logoMiss = new Set(),
    logoPin = window.JG_LOGOS || {},
    logoSites = window.JG_SITE_ICONS !== !1,
    logoWiki = window.JG_WIKIDATA !== !1,
    logoLite = !!(navigator.connection && navigator.connection.saveData);
  let logoPromise = null,
    logoReady = !1,
    logoStamp = 0;
  try {
    localStorage.removeItem("jg.logos.v1");
  } catch (e) {}
  // origine https d'une URL de site (nom de domaine seulement : ni IP, ni localhost, ni port)
  function logoOrigin(s) {
    try {
      const x = new URL(s);
      return /^https?:$/.test(x.protocol) &&
        /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(x.hostname) &&
        !/^\d+(\.\d+){3}$/.test(x.hostname)
        ? "https://" + x.hostname.toLowerCase()
        : "";
    } catch (e) {
      return "";
    }
  }
  // un site tiré de Wikidata n'est admis que si son domaine (les deux derniers libellés) porte le nom de l'enseigne :
  // norauto.fr, carter-cash.com, e.leclerc passent ; norauto.exemple.org ou exemple.org non
  function logoHostOk(id, host) {
    const t = id.replace(/[^a-z0-9]/g, ""),
      p = host.toLowerCase().split(".").slice(-2);
    return t.length < 4
      ? p.includes(t)
      : p
          .join("")
          .replace(/[^a-z0-9]/g, "")
          .includes(t);
  }
  // sites des enseignes déjà cités par les données de la page (prix, promotions) : ils font foi, avant ceux de Wikidata
  for (const k in u)
    for (const x of u[k]) x.c && x.src && !logoOwn[x.c] && (logoOwn[x.c] = logoOrigin(x.src));
  for (const x of v) x.c && x.src && !logoOwn[x.c] && (logoOwn[x.c] = logoOrigin(x.src));
  for (const k in logoDom) logoOwn[k] || (logoOwn[k] = logoOrigin(logoDom[k]));
  // couleur de texte (blanc ou foncé) qui contraste le mieux avec un fond #rrggbb
  function logoFg(h) {
    const [r, g, b] = [1, 3, 5]
        .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)),
      L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return (L + 0.05) / 0.0565 > 1.05 / (L + 0.05) ? "#111315" : "#fff";
  }
  const logoUrl = (id) => logoGot[id] || "";
  function logoSave() {
    P.set(logoKey, { t: logoStamp, m: logoMap, s: logoSite, w: logoWork });
  }
  function logoShow(a, u, fade) {
    const i = document.createElement("img");
    ((i.className = "lg" + (fade ? " fade" : "")),
      (i.alt = ""),
      (i.referrerPolicy = "no-referrer"),
      (i.src = u),
      a.appendChild(i),
      a.classList.add("has-logo"),
      logoWide.has(u) && a.classList.add("lg-wide"));
  }
  // Essaie les candidats dans l'ordre ; le premier qui se charge gagne (une icône de site doit faire >= 32 px).
  // Un échec n'est jamais mémorisé (il peut être passager) ; on retient seulement ce qui a fonctionné.
  function logoTry(id) {
    const c = [];
    if (logoPin[id]) c.push([logoPin[id], 0]);
    else if (!logoLite) {
      const s = logoSites ? logoOwn[id] || logoSite[id] : "",
        w = logoSites ? logoWork[id] : "";
      (w && c.push([w, 32]),
        logoMap[id] && c.push([logoMap[id], 0]),
        s && [s + "/apple-touch-icon.png", s + "/favicon.ico"].forEach((x) => x !== w && c.push([x, 32])));
    }
    // ce qui a déjà échoué pendant cette visite n'est pas redemandé (réponse tardive de Wikidata : seconde chance)
    for (let n = c.length; n--; ) logoMiss.has(c[n][0]) && c.splice(n, 1);
    logoBusy.add(id);
    const next = () => {
      const e = c.shift();
      if (!e) return void logoBusy.delete(id);
      const i = new Image();
      ((i.referrerPolicy = "no-referrer"),
        (i.onload = () => {
          if (i.naturalWidth < e[1] || i.naturalHeight < e[1]) return (logoMiss.add(e[0]), next());
          // logo très large (texte) : on lui laisse presque tout le diamètre, ses coins restent dans le cercle
          (logoBusy.delete(id),
            (logoGot[id] = e[0]),
            i.naturalWidth >= 1.9 * i.naturalHeight && logoWide.add(e[0]));
          e[1] && logoWork[id] !== e[0] && ((logoWork[id] = e[0]), logoSave());
          for (const a of document.querySelectorAll(`.avatar[data-c="${id}"]:not(.has-logo)`))
            logoShow(a, e[0], !0);
        }),
        (i.onerror = () => (logoMiss.add(e[0]), next())),
        (i.src = e[0]));
    };
    next();
  }
  // Pour les seules enseignes affichées
  function logoApply() {
    for (const id of logoWant) logoTried.has(id) || (logoTried.add(id), logoTry(id));
  }
  // Une réponse tardive de Wikidata donne une seconde chance aux enseignes qui n'ont toujours pas de logo
  function logoRetry() {
    for (const id of logoWant) logoGot[id] || logoBusy.has(id) || logoTried.delete(id);
    logoApply();
  }
  function logoLoad() {
    return (
      logoPromise ||
      (logoPromise = (async () => {
        const c = P.get(logoKey, null);
        if (c && c.m && c.s && c.w && c.t && Date.now() - c.t < 30 * 864e5) {
          ((logoStamp = c.t),
            Object.assign(logoMap, c.m),
            Object.assign(logoSite, c.s),
            Object.assign(logoWork, c.w));
          return ((logoReady = !0), logoApply());
        }
        if (logoLite || !logoWiki) return ((logoReady = !0), logoApply());
        const wiki = (async () => {
          try {
            const ids = [...new Set(l.flatMap((e) => e.wd || []))],
              q = `SELECT ?item ?kind ?val ?start WHERE { VALUES ?item { ${ids.map((x) => "wd:" + x).join(" ")} } { ?item p:P8972 ?st. ?st ps:P8972 ?val. FILTER NOT EXISTS { ?st pq:P582 ?e } OPTIONAL { ?st pq:P580 ?start } BIND(0 AS ?kind) } UNION { ?item p:P154 ?st. ?st ps:P154 ?val. FILTER NOT EXISTS { ?st pq:P582 ?e } OPTIONAL { ?st pq:P580 ?start } BIND(1 AS ?kind) } UNION { ?item wdt:P856 ?val. BIND(9 AS ?kind) } }`,
              r = await F(
                "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q),
                {},
                9e3,
              );
            if (!r.ok) throw new Error("wikidata " + r.status);
            const owner = {},
              best = {},
              sites = {};
            for (const e of l) for (const x of e.wd || []) owner[x] = e;
            for (const row of ((await r.json()).results || {}).bindings || []) {
              const e =
                  owner[
                    String((row.item && row.item.value) || "")
                      .split("/")
                      .pop()
                  ],
                val = (row.val && row.val.value) || "",
                k = +(row.kind && row.kind.value);
              if (!e || !(k >= 0)) continue;
              if (9 === k) {
                const h = logoOrigin(val);
                h && logoHostOk(e.id, h.slice(8)) && !sites[e.id] && (sites[e.id] = h);
                continue;
              }
              // seuls les fichiers de Wikimedia Commons sont acceptés ; l'icône prime sur le logo, puis le plus récent
              const f = /^https?:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\/([^?#]+)$/.exec(val),
                s = (row.start && row.start.value) || "",
                o = best[e.id];
              f &&
                (!o || k < o.k || (k === o.k && s > o.s)) &&
                (best[e.id] = {
                  k,
                  s,
                  u: `https://commons.wikimedia.org/wiki/Special:FilePath/${f[1]}?width=128`,
                });
            }
            for (const e of l)
              ((logoMap[e.id] = (best[e.id] || {}).u || ""), (logoSite[e.id] = sites[e.id] || ""));
            ((logoStamp = Date.now()), logoSave());
          } catch (e) {}
        })();
        // le palier 2 (icône du site officiel) ne dépend pas de Wikidata : il démarre au bout de 2,5 s au plus
        await Promise.race([wiki, new Promise((r) => setTimeout(r, 2500))]);
        ((logoReady = !0), logoApply());
        await wiki;
        logoRetry();
      })())
    );
  }
  window.jgLogos = () =>
    Object.fromEntries(
      l.map((c) => [
        c.id,
        {
          logo: logoMap[c.id] || "",
          site: logoOwn[c.id] || logoSite[c.id] || "",
          shown: logoGot[c.id] || "",
        },
      ]),
    );
  // Pastille « avatar » : monogramme de l'enseigne (ou initiale pastel d'un indépendant), remplacé par son logo s'il est connu
  const AVH = [100, 125, 145, 160, 175, 88];
  function av(name, c, net) {
    const s = String(name || "").trim(),
      m = s.match(/[0-9A-Za-zÀ-ÿ]/),
      b = (c && logoBrand[c.id]) || (net && ctBrand[k(net).replace(/[^a-z]/g, "")]),
      g = c ? logoUrl(c.id) : "",
      t = b ? b[1] : (m ? m[0] : "?").toUpperCase();
    let h = 0;
    for (const ch of s) h = (31 * h + ch.charCodeAt(0)) | 0;
    c && (logoWant.add(c.id), logoReady ? logoApply() : logoLoad());
    return `<span class="avatar${b ? " mono" : ""}${t.length > 1 ? " m2" : ""}${g ? " has-logo" : ""}${g && logoWide.has(g) ? " lg-wide" : ""}" style="--h:${AVH[Math.abs(h) % AVH.length]}${b ? `;--bg:${b[0]};--fg:${logoFg(b[0])}` : ""}"${c ? ` data-c="${c.id}"` : ""} aria-hidden="true">${y(t)}${g ? `<img class="lg" alt="" referrerpolicy="no-referrer" src="${y(g)}">` : ""}</span>`;
  }
  // Type de garage (enseigne, indépendant…) : partagé par la liste et la barre de la carte
  function kd(e) {
    return "ct" === me.kind
      ? e.network || "Contrôle technique"
      : e.chain
        ? k(e.name).includes(k(e.chain.name))
          ? "Enseigne"
          : `Enseigne ${e.chain.name}`
        : "sirene" === e.src
          ? "Registre SIRENE"
          : e.dealer
            ? "Atelier de marque"
            : "tyres" === e.shop
              ? "Spécialiste pneus"
              : "Indépendant";
  }
  // Boutons de la carte : appeler (si on a un numéro), itinéraire, avis Google
  function gActions(e) {
    const t = vt(e),
      a = (phoneList(e)[0] || {}).tel || "";
    return `\n      ${t ? `<a class="mini act-call" href="tel:${y(a)}" aria-label="Appeler le ${y(t)}">Appeler</a>` : ""}\n      <a class="mini act-route" href="https://www.google.com/maps/dir/?api=1&amp;destination=${e.lat},${e.lon}" target="_blank" rel="noopener">Itinéraire</a>\n      <a class="mini google act-reviews" href="${y(adGoogle(e))}" target="_blank" rel="noopener">Avis Google</a>\n    `;
  }
  function bt(e, t, a, n, r, s) {
    const i = me.openIds.has(e.id);
    return `<li class="card${i ? " is-open" : ""}${me.sel === e.id ? " is-selected" : ""}" id="c-${t}" data-id="${y(e.id)}">
    <div class="g-main" data-act="more">
      ${av(e.name, e.chain, e.network)}
      <div class="g-id">
        <h3><button type="button" class="g-name linkless" data-act="more" aria-expanded="${i}" aria-controls="m-${t}">${y(e.name)}</button></h3>
        <p class="g-meta"><span class="dist" data-dist="${y(e.id)}">${distHtml(e)}</span><span class="kind">${y(a)}</span>${n}</p>
      </div>
      <div class="g-price">${r}</div>
      ${s.avail || ""}
      <span class="chev" aria-hidden="true">${i ? "Masquer" : "Détails"}</span>
    </div>
    ${s.strip || ""}
    <div class="g-actions">${gActions(e)}</div>
    <div class="g-more" id="m-${t}"${i ? "" : " hidden"}>${i ? s.details() : ""}</div>
  </li>`;
  }
  // Frise « trajet » : adresse de recherche → garage (à vol d'oiseau)
  function rb(e) {
    return me.place && Number.isFinite(e.dist)
      ? `<div class="route" role="group" aria-label="Trajet à vol d'oiseau">
      <div class="r-step r-from"><span class="r-lbl">Votre adresse</span><span class="r-val">${y(me.place.label || "Adresse de recherche")}</span></div>
      <div class="r-step r-to"><span class="r-lbl">${"ct" === me.kind ? "Centre" : "Garage"}</span><span class="r-val" data-ad="${y(e.id)}" aria-live="polite"${adTitleAttr(e)}>${adHtml(e)}</span></div>
      <span class="r-dist">${y(E(e.dist))} à vol d'oiseau</span>
    </div>`
      : "";
  }
  // Fiche d'un garage : mêmes lignes pour tous (« Non renseigné » quand l'information manque), jusqu'à deux numéros
  function wt(e, t) {
    const n = rb(e),
      p = phoneList(e),
      none = (x) => `<span class="fact-none">${x}</span>`,
      wait = e.mbxBusy,
      src = (k) =>
        e.mbx && e.mbx[k]
          ? ' <span class="fact-src" title="Information fournie par Mapbox, à titre indicatif">Mapbox</span>'
          : "",
      r = [
        n
          ? null
          : [
              "Adresse",
              `<span data-ad="${y(e.id)}" aria-live="polite"${adTitleAttr(e)}>${adHtml(e, !0)}</span>`,
            ],
        [
          "Téléphone",
          p.length
            ? `<span class="phones">${p
                .slice(0, 2)
                .map(
                  (x, i) =>
                    `<span class="ph"><a class="phone" href="tel:${y(x.tel)}">${y(x.text)}</a> <button type="button" class="linkish" data-act="copy" data-v="${y(x.text)}">Copier</button>${i ? "" : src("phone")}</span>`,
                )
                .join("")}</span>`
            : `${none(wait ? "Recherche…" : "Non renseigné")} · <a href="${y(adGoogle(e))}" target="_blank" rel="noopener">chercher sur Google Maps</a>`,
        ],
        ["Horaires", e.hours ? y(I(e.hours)) + src("hours") : none(wait ? "Recherche…" : "Non renseignés")],
        [
          "Site",
          e.web
            ? `<a href="${y(e.web)}" target="_blank" rel="noopener">${y(R(e.web))}</a>${src("web")}`
            : none(wait ? "Recherche…" : "Non renseigné"),
        ],
      ]
        .concat(t || [])
        .filter(Boolean);
    return `${n}${r.length ? `<dl class="facts" data-facts="${y(e.id)}">${r.map(([e, t]) => `<dt>${e}</dt><dd${/^(Téléphone|Horaires|Site)$/.test(e) ? ' aria-live="polite"' : ""}>${t}</dd>`).join("")}</dl>` : ""}`;
  }
  function yt(e, t) {
    const a = e.price,
      n = e.promos || [];
    let r;
    var s;
    return (
      (r =
        "chain" === a.kind
          ? `${y(a.ref.label)}${a.ref.note ? " · " + y(a.ref.note) : ""} · relevé le 1er octobre 2026 · <a href="${y(a.ref.src)}" target="_blank" rel="noopener">source</a>`
          : "declared" === a.kind
            ? `${a.n > 1 ? `Prix médian de ${a.n} réparations déclarées` : `1 réparation déclarée, en ${y(G(a.last))}`}${a.ref ? " · " + y(((s = a.ref), `prix enseigne ${C(s.p)}${s.partial ? " hors pièces" : ""}`)) : ""}`
            : "center" === a.kind
              ? "L'enseigne ne publie pas de prix national pour cette prestation : demandez un devis au centre."
              : "Ce garage ne publie pas ses prix : demandez un devis, puis déclarez le prix payé."),
      `${wt(e)}\n      <p class="price-note">${r}</p>\n      ${n.length ? ue(n, t.id) : ""}\n      ${"declared" === a.kind ? it(a.mine, t.id, !1) : ""}\n      ${(function (
        e,
        t,
      ) {
        const a = rt(e, null);
        if (!a.length) return "";
        const n = new Map();
        for (const e of a) {
          const t = Y(e);
          (n.has(t.serviceId) || n.set(t.serviceId, []), n.get(t.serviceId).push(t));
        }
        const r = [...n]
          .sort(
            (e, a) =>
              (a[0] === t) - (e[0] === t) ||
              a[1].length - e[1].length ||
              j(e[0]).localeCompare(j(a[0]), "fr"),
          )
          .map(([e, t]) => {
            t.sort((e, t) => t.month.localeCompare(e.month) || e.price - t.price);
            const a = t.map((e) => e.price),
              n = "autre" === e;
            return `<section class="h-type">\n        <div class="h-type-head"><span class="h-type-name">${y(j(e))}</span>${n ? "" : `<span class="h-median">Prix médian <b>${C(N(a))}</b></span>`}</div>\n        <p class="h-sub">${V(t.length, "réparation", "réparations")}${t.length > 1 && !n ? ` · de ${C(Math.min(...a))} à ${C(Math.max(...a))}` : ""}${n ? " de nature différente : pas de prix médian" : ""}</p>\n        <ul class="h-rows">${t.map((e) => `<li><span class="h-date">${y(G(e.month))}</span><span class="h-model${e.model ? "" : " none"}"><span>${y(vehLabel(e) || "Modèle non renseigné")}</span>${e.rating ? `${re(e.rating)}<span class="sr-only">note ${e.rating} sur 5</span>` : ""}${e.own && stateLabel(e) ? `<span class="h-state">${y(stateLabel(e))}</span>` : ""}${e.own ? `<button type="button" class="linkish h-del" data-act="unrepair" data-rid="${y(e.id)}" aria-label="Supprimer votre réparation : ${y(j(e.serviceId))}, ${y(G(e.month))}">Supprimer</button>` : ""}</span><span class="h-price">${C(e.price)}</span></li>`).join("")}</ul>\n      </section>`;
          })
          .join("");
        return `<details class="history" data-hid="${y(e.id)}"${ot.has(e.id) ? " open" : ""}>\n      <summary>Historique des réparations<span class="h-count">${V(a.length, "réparation", "réparations")}</span></summary>\n      <div class="h-body">\n        <p class="h-note">Par type de prestation, avec le mois, le modèle et l'année du véhicule et la note donnée au garage. Les commentaires et l'immatriculation n'y figurent jamais.</p>\n        ${r}\n      </div>\n    </details>`;
      })(
        e,
        t.id,
      )}\n      <div><button type="button" class="btn" data-act="declare" aria-haspopup="dialog">${he("plus")}Déclarer une réparation</button></div>`
    );
  }
  function $t(e) {
    const t = e.ct;
    if (!t)
      return `${wt(e)}<p class="price-note">Ce centre n'a pas déclaré de prix pour les voitures particulières : appelez-le.</p>`;
    const a =
      isFinite(t.cvMin) || isFinite(t.cvMax)
        ? isFinite(t.cvMin) && isFinite(t.cvMax) && t.cvMin !== t.cvMax
          ? `${C(t.cvMin)} à ${C(t.cvMax)}`
          : C(isFinite(t.cvMin) ? t.cvMin : t.cvMax)
        : "";
    return `${wt(e, [a ? ["Contre-visite", a] : null])}\n      <p class="price-note">Visite ${y(t.energy || "")}${t.cat ? " · " + y(t.cat.toLowerCase()) : ""}${
      t.date
        ? " · en vigueur depuis le " +
          y(
            (function (e) {
              const t = new Date(e);
              return isNaN(t)
                ? String(e || "")
                : t.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
            })(t.date),
          )
        : ""
    }${t.matched ? "" : " · aucun tarif déclaré pour l'énergie choisie"} · prix déclaré par le centre à la DGCCRF.</p>`;
  }
  // Peint une fiche ouverte ou fermée (sans toucher à la sélection)
  function kc(e, r, n) {
    n = n || me.view.find((t) => t.id === e.dataset.id);
    const s = e.querySelector(".g-more");
    ((s.innerHTML = r && n ? ("ct" === me.kind ? $t(n) : yt(n, fe())) : ""),
      (s.hidden = !r),
      e.classList.toggle("is-open", r),
      e.querySelector(".g-name").setAttribute("aria-expanded", String(r)),
      (e.querySelector(".chev").textContent = r ? "Masquer" : "Détails"));
    r && n && (adEnsure(n), mbxEnsure(n));
  }
  // Une seule fiche ouverte à la fois : l'ouvrir la sélectionne (carte + barre récapitulative)
  function kt(e, t) {
    const a = e.dataset.id,
      n = me.view.find((e) => e.id === a);
    if (!n) return;
    const r = void 0 === t ? !me.openIds.has(a) : t,
      o = e.getBoundingClientRect().top;
    if (r)
      for (const t of [...me.openIds]) {
        if (t === a) continue;
        me.openIds.delete(t);
        const n = pe.list.querySelector(`[data-id="${CSS.escape(t)}"]`);
        n && kc(n, !1);
      }
    (r ? me.openIds.add(a) : me.openIds.delete(a), kc(e, r, n));
    // la fiche cliquée reste sous le pointeur même si une fiche ouverte au-dessus vient de se refermer
    const i = e.getBoundingClientRect().top - o;
    (i && (ge() ? (pe.panelCol.scrollTop += i) : window.scrollBy(0, i)),
      sl(r ? a : me.sel === a ? null : me.sel));
  }
  function St(e) {
    ((me.viewMode = e),
      document.body.classList.toggle("is-map", "map" === e),
      (pe.mapFab.innerHTML =
        "map" === e ? `${he("list")}<span>Liste</span>` : `${he("map")}<span>Carte</span>`),
      pe.mapFab.setAttribute(
        "aria-label",
        "map" === e ? "Afficher la liste des garages" : "Afficher la carte des garages",
      ),
      "map" === e && Et());
  }
  // ----- Sélection d'un garage : fiche surlignée, marqueur agrandi + bulle, barre récapitulative -----
  const Mk = new Map();
  let Hl = null;
  const mkR = (e, t) => (t ? 11 : mt(e) ? 8 : 6),
    mkS = (e, t) => ({
      color: Ct("--mk-ring") || "#fff",
      weight: t ? 3.5 : 2.5,
      fillColor: t
        ? Ct("--mk-sel") || "#0a7427"
        : mt(e)
          ? Ct("--mk-priced") || "#0a0d0a"
          : Ct("--mk-none") || "#8f998c",
      fillOpacity: 1,
    }),
    // Cadrage de la carte : on tient compte du panneau (ordinateur) ou des barres (mobile)
    fo = () => {
      const e = pe.panelCol.getBoundingClientRect();
      return ge()
        ? { paddingTopLeft: [Math.round(e.right) + 24, 24], paddingBottomRight: [24, 24] }
        : { paddingTopLeft: [10, 72], paddingBottomRight: [10, 96] };
    },
    po = () => {
      const e = pe.panelCol.getBoundingClientRect();
      return ge()
        ? { paddingTopLeft: [Math.round(e.right) + 40, 90], paddingBottomRight: [70, 170], animate: !0 }
        : { paddingTopLeft: [40, 120], paddingBottomRight: [40, 400], animate: !0 };
    },
    mp = (e) =>
      mt(e)
        ? `${"declared" === e.price.kind ? "prix déclaré " : ""}${C(e.price.amount)}`
        : "ct" === me.kind
          ? "Prix non déclaré"
          : "Prix non publié";
  function bindTip(m, e, t) {
    (m.unbindTooltip(),
      m.bindTooltip(
        t
          ? `<b>${y(e.name)}</b><span>${y(adText(e) || mp(e))}</span>`
          : `<b>${y(e.name)}</b><span>${y(mp(e))} · ${y(E(e.dist))}</span>`,
        {
          permanent: t,
          direction: "top",
          offset: [0, t ? -14 : -9],
          className: "tip" + (t ? " tip-sel" : ""),
          opacity: 1,
        },
      ),
      t && m.openTooltip());
  }
  function slMap(pan) {
    if (!Mt || !xt) return;
    Hl && (xt.removeLayer(Hl), (Hl = null));
    let s = null;
    Mk.forEach((m, id) => {
      const t = id === me.sel;
      (t && (s = m), m.setStyle(mkS(m.jg, t)), m.setRadius(mkR(m.jg, t)));
      t !== !!m.jgOn && ((m.jgOn = t), bindTip(m, m.jg, t));
    });
    s &&
      ((Hl = L.circleMarker(s.getLatLng(), {
        radius: 22,
        stroke: !1,
        fillColor: Ct("--mk-sel") || "#0a7427",
        fillOpacity: 0.2,
        interactive: !1,
      }).addTo(xt)),
      s.bringToFront(),
      pan && pe.map.offsetWidth && Mt.panInside(s.getLatLng(), po()));
  }
  // Barre récapitulative flottante (équivalent de la fiche « commande » sous la carte)
  function mi(e) {
    const t = e.price || { kind: "none" },
      n = e.rating,
      r =
        "declared" === t.kind
          ? '<span class="tag info">Prix déclaré</span>'
          : "chain" === t.kind
            ? `<span class="tag ${t.partial ? "warn" : "ok"}">${t.partial ? "Pièces en plus" : "Prix enseigne"}</span>`
            : "official" === t.kind
              ? '<span class="tag ok">Prix officiel</span>'
              : "";
    return `<div class="mi-top">
      <h2 class="mi-title">${y(e.name)}</h2>
      <div class="mi-tags">${r}${ce(e.promos)}</div>
      <button type="button" class="mi-x" data-mi="close" aria-label="Fermer la fiche rapide">${he("close")}</button>
    </div>
    <div class="mi-row">
      <div class="mi-who">${av(e.name, e.chain, e.network)}<span><small>Type</small><b>${y(kd(e))}</b></span></div>
      <dl class="mi-facts">
        <div><dt>Prix</dt><dd>${y(mp(e))}</dd></div>
        <div><dt>Distance</dt><dd>${y(E(e.dist))}</dd></div>
        ${n ? `<div><dt>Note</dt><dd>★ ${te(n.avg)}/5</dd></div>` : ""}
      </dl>
      <div class="mi-cta">
        <a class="cta" href="https://www.google.com/maps/dir/?api=1&amp;destination=${e.lat},${e.lon}" target="_blank" rel="noopener">${he("route")}Itinéraire</a>
        <button type="button" class="cta alt" data-mi="card">Voir la fiche</button>
      </div>
    </div>`;
  }
  function sl(e) {
    const t = e && me.view.find((t) => t.id === e);
    me.sel = t ? e : null;
    for (const e of pe.list.querySelectorAll(".card.is-selected")) e.classList.remove("is-selected");
    if (t) {
      const e = pe.list.querySelector(`[data-id="${CSS.escape(t.id)}"]`);
      e && e.classList.add("is-selected");
    }
    ((pe.mapInfo.innerHTML = t ? mi(t) : ""), (pe.mapInfo.hidden = !t || pe.mapPane.hidden), slMap(!0));
    t && adEnsure(t);
  }
  // Ferme la barre : referme aussi la fiche ouverte
  function sx() {
    const e = me.sel;
    if (!e) return;
    const t = pe.list.querySelector(`[data-id="${CSS.escape(e)}"]`);
    (t && me.openIds.has(e) ? kt(t, !1) : sl(null),
      t && t.querySelector(".g-name").focus({ preventScroll: !0 }));
  }
  pe.mapInfo.addEventListener("click", (e) => {
    const t = e.target.closest("[data-mi]");
    t && ("close" === t.dataset.mi ? sx() : me.sel && _t(me.sel, !0));
  });
  (pe.moreBtn.addEventListener("click", () => {
    ((me.shown += r), ft());
  }),
    pe.toolbar.addEventListener("click", (e) => {
      const t = e.target.closest("[data-sort]"),
        a = e.target.closest("[data-filter]");
      if (t) {
        me.sort = t.dataset.sort;
        for (const e of pe.toolbar.querySelectorAll("[data-sort]"))
          e.setAttribute("aria-pressed", String(e === t));
      }
      (a && gt(a.dataset.filter), (t || a) && ((me.shown = r), ht()));
    }),
    pe.summary.addEventListener("click", (e) => {
      const t = e.target.closest("[data-chain]");
      if (!t) return;
      const a = t.dataset.chain,
        n = "chain:" + a;
      (gt(me.filter === n ? "all" : n), (me.shown = r), ht());
      const s = pe.summary.querySelector(`[data-chain="${a}"]`);
      s && s.focus();
    }),
    pe.mapFab.addEventListener("click", () => St("map" === me.viewMode ? "list" : "map")),
    pe.list.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-act]");
      if (!t) return;
      const a = t.closest(".card");
      if (!a) return;
      const n = t.dataset.act;
      if ("more" === n) {
        if (e.target.closest("a") || (e.target.closest("button") && !e.target.closest(".g-name"))) return;
        kt(a);
      } else if ("copy" === n) {
        try {
          (await navigator.clipboard.writeText(t.dataset.v), (t.textContent = "Copié"));
        } catch (e) {
          const n = (t.parentElement || a).querySelector(".phone");
          if (n) {
            const e = document.createRange();
            e.selectNodeContents(n);
            const t = getSelection();
            (t.removeAllRanges(), t.addRange(e));
          }
          t.textContent = "Sélectionné";
        }
        setTimeout(() => {
          t.textContent = "Copier";
        }, 1600);
      } else if ("declare" === n) {
        const e = me.view.find((e) => e.id === a.dataset.id);
        e && Ot({ garage: qt(e, "search"), svcId: fe().id });
      } else if ("unrepair" === n) {
        unrepair(t.dataset.rid, "Réparation supprimée.", !0);
        // la ligne cliquée disparaît : le focus revient sur l'historique du garage (ou sur son nom)
        const id = CSS.escape(a.dataset.id),
          f = pe.list.querySelector(`details.history[data-hid="${id}"] > summary`) || pe.list.querySelector(`[data-id="${id}"] .g-name`);
        f && f.focus({ preventScroll: !0 });
      }
    }),
    pe.list.addEventListener(
      "toggle",
      (e) => {
        const t = e.target;
        t.matches &&
          t.matches("details.history") &&
          (t.open ? ot.add(t.dataset.hid) : ot.delete(t.dataset.hid));
      },
      !0,
    ),
    pe.energy.addEventListener("change", () => {
      "ct" === me.kind && me.raw.length && ht();
    }));
  let Mt = null,
    xt = null,
    Lt = null;
  function Ct(e) {
    return getComputedStyle(document.documentElement).getPropertyValue(e).trim();
  }
  const At = () => "garages" === me.screen && !pe.mapPane.hidden && (ge() || "map" === me.viewMode);
  function Et() {
    "live" === me.mode &&
      me.place &&
      me.raw.length &&
      !pe.mapPane.hidden &&
      (At()
        ? ((me.mapDirty = !1),
          (window.L
            ? Promise.resolve()
            : (Lt ||
                (Lt = loadScript(__LEAFLET_URLS__).catch((e) => {
                  throw ((Lt = null), e);
                })),
              Lt)
          )
            .then(() =>
              (function (e) {
                if (!window.L || !me.place) return;
                const t = +pe.radius.value,
                  a = L.latLng(me.place.lat, me.place.lon).toBounds(2e3 * t);
                if (!Mt) {
                  ((Mt = L.map(pe.map, { preferCanvas: !0, scrollWheelZoom: ge(), zoomSnap: 0.5 })),
                    Mt.zoomControl.setPosition("topright"),
                    Mt.fitBounds(a, fo()));
                  // Fonds de carte, du préféré au dernier recours : Mapbox (seulement si la page en a le jeton, voir modules/mapbox.js), le Plan IGN, puis
                  // CARTO. Un seul est affiché : s'il n'a chargé aucune tuile et en a refusé deux (jeton refusé, service en panne), on passe au suivant.
                  const bases = [],
                    mapbox = mapboxConfig();
                  (mapbox && bases.push(L.tileLayer(mapboxTileUrl(mapbox), MAPBOX_OPTIONS)),
                    bases.push(
                      L.tileLayer(
                        "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
                        {
                          maxZoom: 19,
                          maxNativeZoom: 18,
                          attribution: "Fond : Plan IGN © IGN – Géoplateforme",
                        },
                      ),
                      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
                        subdomains: "abcd",
                        maxZoom: 19,
                        attribution: "Fond : © CARTO, © les contributeurs d'OpenStreetMap",
                      }),
                    ));
                  const showBase = (i) => {
                    const layer = bases[i],
                      isMapbox = !!mapbox && 0 === i;
                    let loaded = 0,
                      failed = 0,
                      passed = !1;
                    mbxLive = isMapbox; // les fiches ne sont complétées par Mapbox que tant que la carte affiche ses tuiles (réglage « map »)
                    (layer.on("tileload", () => {
                      loaded++;
                    }),
                      layer.on("tileerror", () => {
                        (failed++,
                          !passed &&
                            0 === loaded &&
                            failed >= 2 &&
                            i + 1 < bases.length &&
                            ((passed = !0), isMapbox && (mbxFallen = !0), Mt.removeLayer(layer), showBase(i + 1)));
                      }),
                      layer.addTo(Mt));
                  };
                  (showBase(0),
                    Mt.attributionControl.addAttribution("Garages © les contributeurs d'OpenStreetMap"),
                    (xt = L.layerGroup().addTo(Mt)));
                }
                const n =
                    [me.place.lat, me.place.lon, t, Ct("--mk-priced")].join("|") +
                    "|" +
                    e
                      .map((e) => e.id + ":" + (mt(e) ? e.price.amount : "") + (le(e.promos) ? "p" : ""))
                      .sort()
                      .join(","),
                  r = n === me.mapKey;
                if (
                  (requestAnimationFrame(() => {
                    (Mt.invalidateSize(), r ? slMap(!0) : Mt.fitBounds(a, fo()));
                  }),
                  r)
                )
                  return;
                ((me.mapKey = n), xt.clearLayers(), Mk.clear(), (Hl = null));
                const s = Ct("--mk-ring") || "#fff",
                  i = Ct("--mk-sel") || "#0a7427";
                (L.circle([me.place.lat, me.place.lon], {
                  radius: 1e3 * t,
                  color: i,
                  weight: 1.5,
                  opacity: 0.55,
                  dashArray: "6 8",
                  fillColor: i,
                  fillOpacity: 0.05,
                  interactive: !1,
                }).addTo(xt),
                  // les garages avec prix sont dessinés en dernier (au-dessus des autres)
                  e
                    .slice()
                    .sort((e, t) => mt(e) - mt(t))
                    .forEach((e) => {
                      const t = L.circleMarker([e.lat, e.lon], { ...mkS(e, !1), radius: mkR(e, !1) })
                        .on("click", () => (ge() ? _t(e.id, !0) : sl(e.id)))
                        .addTo(xt);
                      ((t.jg = e), Mk.set(e.id, t), bindTip(t, e, !1));
                    }),
                  L.circleMarker([me.place.lat, me.place.lon], {
                    radius: 9,
                    color: Ct("--mk-user-ring") || s,
                    weight: 3,
                    fillColor: Ct("--mk-user") || "#fff",
                    fillOpacity: 1,
                  })
                    .bindTooltip("Votre adresse", {
                      direction: "top",
                      offset: [0, -9],
                      className: "tip",
                      opacity: 1,
                    })
                    .addTo(xt),
                  slMap());
              })(me.view),
            )
            .catch(() => {
              pe.map.innerHTML =
                '<p class="status err" style="margin:12px">La carte n\'a pas pu se charger. La liste reste complète.</p>';
            }))
        : (me.mapDirty = !0));
  }
  function _t(e, t) {
    const a = me.view.findIndex((t) => t.id === e);
    if (a < 0) return;
    (ge() || "map" !== me.viewMode || St("list"), a >= me.shown && ((me.shown = a + 1), ft()));
    const n = pe.list.querySelector(`[data-id="${CSS.escape(e)}"]`);
    n && (t && kt(n, !0), Ft(n));
  }
  function Ft(e) {
    (e.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    }),
      e.setAttribute("tabindex", "-1"),
      e.focus({ preventScroll: !0 }),
      e.classList.add("flash"),
      setTimeout(() => e.classList.remove("flash"), 1800));
  }
  (matchMedia("(min-width:1024px)").addEventListener("change", () => {
    (Mt && Mt.scrollWheelZoom[ge() ? "enable" : "disable"](), me.mapDirty ? Et() : Mt && Mt.invalidateSize());
  }),
    pe.map.addEventListener("click", (e) => {
      const t = e.target.closest("[data-focus]");
      t && (ge() || St("list"), _t(t.dataset.focus, !0));
    }));
  const Pt = {
    el: w("#repairDlg"),
    form: w("#repairForm"),
    note: w("#dlgNote"),
    garage: w("#rGarage"),
    gList: w("#rGarageList"),
    gInfo: w("#rGarageInfo"),
    gErr: w("#rGarageErr"),
    model: w("#rModel"),
    modelInfo: w("#rModelInfo"),
    modelErr: w("#rModelErr"),
    mList: w("#rModelList"),
    plate: w("#rPlate"),
    plateErr: w("#rPlateErr"),
    plateSay: w("#rPlateSay"),
    year: w("#rYear"),
    yearErr: w("#rYearErr"),
    service: w("#rService"),
    price: w("#rPrice"),
    priceErr: w("#rPriceErr"),
    date: w("#rDate"),
    dateErr: w("#rDateErr"),
    comment: w("#rComment"),
    stars: w("#rStars"),
    rateWord: w("#rRateWord"),
    ratingErr: w("#rRatingErr"),
    picked: null,
    items: [],
    index: -1,
    timer: null,
    ctl: null,
    loading: !1,
    listClosedAt: 0,
    plateLive: !1,
    rating: 0,
  };
  !(function () {
    const e = [];
    for (const t of o) {
      if ("ct" === t.kind) continue;
      let a = e.find((e) => e.name === t.g);
      (a || e.push((a = { name: t.g, items: [] })), a.items.push(t));
    }
    Pt.service.innerHTML =
      e
        .map(
          (e) =>
            `<optgroup label="${y(e.name)}">${e.items.map((e) => `<option value="${e.id}">${y(e.label)}</option>`).join("")}</optgroup>`,
        )
        .join("") +
      '<optgroup label="Autre"><option value="autre">Autre réparation (précisez en commentaire)</option></optgroup>';
  })();
  // ----- Véhicule : immatriculation, modèle (liste de suggestions) et année du modèle ---------------------------------------
  // Immatriculation : format SIV, 2 lettres - 3 chiffres - 2 lettres (EZ-108-BC). Le champ se met en forme à la saisie :
  // majuscules, tirets posés tout seuls, et tout caractère qui n'a pas sa place (un chiffre là où une lettre est attendue)
  // est refusé avec un rappel du format (affiché, et annoncé aux lecteurs d'écran, pour qui une frappe ignorée ne se voit pas).
  // L'ancien format (1234 AB 56) n'est pas accepté.
  const PLATE_SEP = new RegExp("[\\s\\-._/\\u2010-\\u2015]"),
    PLATE_HELP = "Immatriculation incomplète. Format attendu : AB-123-CD (2 lettres, 3 chiffres, 2 lettres).",
    PLATE_LIVE = "Une plaque s'écrit AB-123-CD : 2 lettres, 3 chiffres, 2 lettres.",
    YEAR_MAX = +s.slice(0, 4);
  // Trois groupes : 2 lettres, 3 chiffres, 2 lettres. Un groupe plein passe au suivant tout seul ; un séparateur saisi (tiret,
  // espace, point…) y passe aussi, ce qui laisse corriger un caractère au milieu sans pousser les groupes suivants dans de
  // mauvaises cases. Un caractère qui ne peut aller nulle part (chiffre dans les lettres, 8e caractère, accent…) est refusé.
  // Les tirets ne sont posés qu'avec le caractère qui suit : « EZ » reste « EZ », jamais « EZ- » (Retour arrière le garderait).
  function plateMask(raw) {
    const groups = ["", "", ""];
    let g = 0,
      dropped = false;
    for (const ch of String(raw || "")) {
      if (PLATE_SEP.test(ch)) {
        if (groups[g] && g < 2) g++;
        continue;
      }
      if (!/[A-Za-z0-9]/.test(ch)) {
        dropped = true;
        continue;
      }
      const c = ch.toUpperCase(),
        size = 1 === g ? 3 : 2;
      if (g < 2 && groups[g].length === size) g++;
      const room = groups[g].length < (1 === g ? 3 : 2),
        fits = 1 === g ? c >= "0" && c <= "9" : c >= "A" && c <= "Z";
      room && fits ? (groups[g] += c) : (dropped = true);
    }
    return { value: groups.filter(Boolean).join("-"), dropped };
  }
  // Le curseur reste devant le même caractère utile quand le masque ajoute ou retire un tiret (collage au milieu, etc.).
  function plateInput() {
    const el = Pt.plate,
      at = null == el.selectionStart ? el.value.length : el.selectionStart,
      masked = plateMask(el.value),
      caret = plateMask(el.value.slice(0, at)).value.length;
    if (el.value !== masked.value) {
      el.value = masked.value;
      try {
        el.setSelectionRange(caret, caret);
      } catch (err) {}
    }
    Pt.plateLive = masked.dropped;
    Tt(el, Pt.plateErr, masked.dropped ? PLATE_LIVE : "");
    Pt.plateSay.textContent = masked.dropped ? PLATE_LIVE : "";
  }
  // Année du modèle : 4 chiffres, entre 1950 et l'année en cours, jamais après la date de la réparation.
  function yearMsg(year, date) {
    if (!year) return "Indiquez l'année du modèle.";
    if (!/^\d{4}$/.test(year)) return "Année non reconnue. Exemple : 2019.";
    if (+year < YEAR_MIN || +year > YEAR_MAX)
      return `L'année du modèle doit être comprise entre ${YEAR_MIN} et ${YEAR_MAX}.`;
    if (/^\d{4}-/.test(date) && +year > +date.slice(0, 4))
      return "L'année du modèle ne peut pas être postérieure à la date de la réparation.";
    return "";
  }
  function yearInput() {
    const digits = Pt.year.value.replace(/\D/g, "").slice(0, 4);
    if (digits !== Pt.year.value) Pt.year.value = digits;
    Tt(Pt.year, Pt.yearErr, "");
  }
  // Corriger la date peut lever (ou créer) le désaccord avec l'année : on ne remet le message à jour que s'il y en avait un.
  function yearRecheck() {
    Pt.yearErr.hidden || Tt(Pt.year, Pt.yearErr, yearMsg(Pt.year.value.trim(), Pt.date.value));
  }
  // Modèle (et année) tels qu'on les affiche partout : « Peugeot 208 · 2019 ». Jamais l'immatriculation.
  function vehLabel(r) {
    return [r.model, r.year].filter(Boolean).join(" · ");
  }
  // À l'ouverture du formulaire, le véhicule de la dernière déclaration est repris (immatriculation, modèle, année).
  function vehPrefill() {
    const last = RS.vehicles()[0]; // la mémoire survit à « Annuler » et « Supprimer »
    Pt.model.value = last ? last.model : "";
    Pt.plate.value = (last && last.plate) || "";
    Pt.year.value = last && last.year ? String(last.year) : "";
    Pt.plateLive = false;
    Pt.plateSay.textContent = "";
    mdlHide();
  }

  // Modèle : suggestions tirées du catalogue (b : « Marque Modèle »), sans accents ni ponctuation, et des modèles déjà
  // déclarés, placés devant. Classement : nom exact, nom suivi d'autres mots, début de nom, mots commençant par la saisie,
  // saisie contenue dans le nom, puis saisie collée (« chr » trouve « C-HR »). Un modèle déjà déclaré gagne un rang ; à rang
  // égal, il passe devant, puis l'ordre du catalogue (marques et modèles les plus courants d'abord).
  const mdlEntry = (name, i, own) => {
      const k = H(name),
        brand = O.find((o) => K(k, o.k));
      return { m: name, k, mk: brand ? k.slice(brand.k.length + 1) : k, i, own };
    },
    mdlCatalog = b.map((name, i) => mdlEntry(name, i, false)),
    mdl = { items: [], index: -1 },
    // Champ vide : les modèles déjà déclarés, puis ceux-ci (les plus répandus), pour qu'un clic dans le champ montre une liste.
    POPULAR = [
      "Renault Clio",
      "Peugeot 208",
      "Citroën C3",
      "Dacia Sandero",
      "Peugeot 308",
      "Renault Captur",
      "Volkswagen Golf",
      "Renault Twingo",
      "Toyota Yaris",
      "Peugeot 2008",
      "Renault Mégane",
      "Dacia Duster",
    ];
  function mdlFind(query) {
    const own = [],
      seen = new Set();
    const declared = RS.vehicles()
      .map((v) => v.model)
      .concat(RS.own().slice().sort((r1, r2) => String(r2.createdAt).localeCompare(String(r1.createdAt))).map((r) => r.model));
    for (const model of declared) {
      const entry = model && mdlEntry(model, own.length - 1e4, true);
      if (entry && !seen.has(entry.k)) {
        seen.add(entry.k);
        own.push(entry);
      }
    }
    const q = H(
      String(query || "")
        .replace(/^\s*vw\b/i, "volkswagen")
        .replace(/^\s*mercedes[\s-]*benz\b/i, "mercedes"),
    );
    if (!q)
      return own
        .slice(0, 8)
        .concat(
          POPULAR.map((name) => mdlCatalog.find((c) => c.m === name)).filter((c) => c && !seen.has(c.k)),
        )
        .slice(0, 12);
    const toks = q.split(" "),
      packed = q.replace(/ /g, ""),
      rank = (c) => {
        if (c.k === q || c.mk === q) return 0;
        if (c.k.startsWith(q + " ") || c.mk.startsWith(q + " ")) return 1;
        if (c.k.startsWith(q) || c.mk.startsWith(q)) return 2;
        const words = c.k.split(" ");
        if (toks.every((tok) => words.some((word) => word.startsWith(tok)))) return 3;
        if (toks.every((tok) => c.k.includes(tok))) return 4;
        return packed.length > 1 && c.k.replace(/ /g, "").includes(packed) ? 5 : -1;
      };
    return own
      .concat(mdlCatalog.filter((c) => !seen.has(c.k)))
      .map((c) => ({ c, r: rank(c) }))
      .filter((x) => x.r >= 0)
      .sort((x1, x2) => x1.r - x1.c.own - (x2.r - x2.c.own) || x1.c.i - x2.c.i)
      .slice(0, 12)
      .map((x) => x.c);
  }
  function mdlHide() {
    Pt.mList.hidden = true;
    Pt.mList.innerHTML = "";
    Pt.model.setAttribute("aria-expanded", "false");
    Pt.model.removeAttribute("aria-activedescendant");
    mdl.items = [];
    mdl.index = -1;
  }
  // Une seule suggestion identique à ce qui est déjà saisi n'apporte rien : la liste reste fermée.
  function mdlShow(items) {
    mdl.items = 1 === items.length && H(items[0].m) === H(Pt.model.value) ? [] : items;
    mdl.index = -1;
    if (!mdl.items.length) return mdlHide();
    Pt.mList.innerHTML = mdl.items
      .map(
        (c, i) =>
          `<li role="option" id="ms-${i}" data-i="${i}" aria-selected="false"><span class="s-main">${y(c.m)}</span>${c.own ? '<span class="s-sub">déjà déclaré</span>' : ""}</li>`,
      )
      .join("");
    Pt.mList.hidden = false;
    Pt.mList.scrollTop = 0;
    Pt.model.setAttribute("aria-expanded", "true");
    Pt.model.removeAttribute("aria-activedescendant");
  }
  // Flèches : l'option active change sur place (la liste n'est pas redessinée) et reste visible dans la liste.
  function mdlMove(step) {
    const n = mdl.items.length;
    mdl.index = mdl.index < 0 ? (step > 0 ? 0 : n - 1) : (mdl.index + step + n) % n;
    [...Pt.mList.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === mdl.index)));
    const li = Pt.mList.children[mdl.index],
      top = li.offsetTop,
      bottom = top + li.offsetHeight;
    if (top < Pt.mList.scrollTop + 6) Pt.mList.scrollTop = Math.max(0, top - 6);
    else if (bottom > Pt.mList.scrollTop + Pt.mList.clientHeight - 6)
      Pt.mList.scrollTop = bottom - Pt.mList.clientHeight + 6;
    Pt.model.setAttribute("aria-activedescendant", li.id);
  }
  function mdlPick(i) {
    const c = mdl.items[i];
    if (!c) return;
    Pt.model.value = c.m;
    Tt(Pt.model, Pt.modelErr, "");
    mdlHide();
  }
  function wireVehicle() {
    Pt.model.addEventListener("input", () => {
      Tt(Pt.model, Pt.modelErr, "");
      mdlShow(mdlFind(Pt.model.value));
    });
    Pt.model.addEventListener("focus", () => {
      Pt.model.value.trim() || mdlShow(mdlFind(""));
    });
    Pt.model.addEventListener("keydown", (e) => {
      const open = !Pt.mList.hidden;
      if ("Escape" === e.key && open) {
        e.preventDefault();
        e.stopPropagation();
        Pt.listClosedAt = Date.now();
        return void mdlHide();
      }
      // Entrée choisit l'option active (le champ garde le focus), sinon passe au champ suivant, comme pour le garage.
      if ("Enter" === e.key) {
        e.preventDefault();
        if (open && mdl.index >= 0) return void mdlPick(mdl.index);
        mdlHide();
        return void Pt.plate.focus();
      }
      if ("ArrowDown" === e.key || "ArrowUp" === e.key) {
        open || mdlShow(mdlFind(Pt.model.value));
        if (!mdl.items.length) return;
        e.preventDefault();
        mdlMove("ArrowDown" === e.key ? 1 : -1);
      }
    });
    Pt.model.addEventListener("blur", () => {
      setTimeout(() => document.activeElement === Pt.model || mdlHide(), 150);
      const name = J(Pt.model.value);
      name && (Pt.model.value = name);
    });
    Pt.mList.addEventListener("mousedown", (e) => e.preventDefault());
    Pt.mList.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-i]");
      li && mdlPick(+li.dataset.i);
    });
    Pt.plate.addEventListener("input", (e) => e.isComposing || plateInput());
    Pt.plate.addEventListener("compositionend", plateInput);
    Pt.plate.addEventListener("blur", () => {
      if (Pt.plateLive) {
        Pt.plateLive = false;
        Tt(Pt.plate, Pt.plateErr, "");
        Pt.plateSay.textContent = "";
      }
    });
    Pt.year.addEventListener("input", yearInput);
  }
  const Rt = { search: "dans votre recherche", declared: "déjà déclaré", sirene: "registre des entreprises" };
  function qt(e, t) {
    return {
      id: e.id,
      name: e.name,
      addr: adText(e),
      lat: Number.isFinite(e.lat) ? e.lat : null,
      lon: Number.isFinite(e.lon) ? e.lon : null,
      chainId: e.chain ? e.chain.id : e.chainId || "",
      src: t,
    };
  }
  function It(e) {
    return me.place && Number.isFinite(e.lat) && Number.isFinite(e.lon) ? "à " + E(_(me.place, e)) : "";
  }
  function Tt(e, t, a) {
    ((t.textContent = a),
      (t.hidden = !a),
      a ? e.setAttribute("aria-invalid", "true") : e.removeAttribute("aria-invalid"));
  }
  function Dt() {
    const e = Pt.picked;
    e
      ? ((Pt.gInfo.className = "picked"),
        (Pt.gInfo.textContent =
          "✓ " + [e.addr || "Adresse non renseignée", It(e), Rt[e.src]].filter(Boolean).join(" · ")))
      : ((Pt.gInfo.className = "hint"),
        (Pt.gInfo.textContent = `Tapez quelques lettres : garages de votre dernière recherche, déjà déclarés${"live" === me.mode ? " ou du registre des entreprises" : ""}. Un garage absent de la liste peut être saisi tel quel.`));
  }
  function jt() {
    Pt.items.length || Pt.loading
      ? ((Pt.gList.innerHTML =
          Pt.items
            .map(
              (e, t) =>
                `<li role="option" id="gs-${t}" data-i="${t}" aria-selected="${t === Pt.index}"><span class="s-main">${y(e.name)}</span><span class="s-sub">${y([e.addr, It(e), Rt[e.src]].filter(Boolean).join(" · "))}</span></li>`,
            )
            .join("") +
          (Pt.loading
            ? '<li class="s-loading" role="presentation">Recherche dans le registre des entreprises…</li>'
            : "")),
        (Pt.gList.hidden = !1),
        Pt.garage.setAttribute("aria-expanded", "true"),
        Pt.index >= 0
          ? Pt.garage.setAttribute("aria-activedescendant", "gs-" + Pt.index)
          : Pt.garage.removeAttribute("aria-activedescendant"))
      : zt();
  }
  function zt() {
    ((Pt.gList.hidden = !0),
      Pt.garage.setAttribute("aria-expanded", "false"),
      Pt.garage.removeAttribute("aria-activedescendant"),
      (Pt.index = -1));
  }
  function Bt() {
    (clearTimeout(Pt.timer), Pt.ctl && Pt.ctl.abort(), (Pt.loading = !1));
  }
  function Nt(e) {
    const t = Pt.items[e];
    t && (Bt(), (Pt.picked = t), (Pt.garage.value = t.name), Tt(Pt.garage, Pt.gErr, ""), zt(), Dt());
    if (t && !t.addr && "search" === t.src) {
      const g = me.garages.find((x) => x.id === t.id);
      g &&
        adEnsure(g).then(() => {
          Pt.picked === t && g.addr && ((t.addr = adText(g)), Dt());
        });
    }
  }
  (Pt.garage.addEventListener("input", () => {
    ((Pt.picked = null), Tt(Pt.garage, Pt.gErr, ""), Dt(), Bt());
    const e = Pt.garage.value.trim();
    if (e.length < 2) return ((Pt.items = []), void zt());
    ((Pt.items = (function (e) {
      const t = tt(e).split(" ").filter(Boolean);
      if (!t.length) return [];
      const a = [];
      for (const e of (function () {
        const e = new Map();
        for (const t of me.garages) e.has(t.id) || e.set(t.id, qt(t, "search"));
        for (const t of RS.own())
          e.has(t.garageId) ||
            e.set(t.garageId, {
              id: t.garageId,
              name: t.garageName,
              addr: t.garageAddr || "",
              lat: t.lat,
              lon: t.lon,
              chainId: t.chainId || "",
              src: "declared",
            });
        return [...e.values()];
      })()) {
        const n = tt(e.name);
        t.every((t) => (n + " " + tt(e.addr)).includes(t)) &&
          a.push({
            g: e,
            rank: n.startsWith(t.join(" ")) ? 0 : t.every((e) => n.includes(e)) ? 1 : 2,
            own: "declared" === e.src ? 0 : 1,
            d: me.place && Number.isFinite(e.lat) ? _(me.place, e) : 1e9,
          });
      }
      return a
        .sort((e, t) => e.rank - t.rank || e.own - t.own || e.d - t.d)
        .slice(0, 8)
        .map((e) => e.g);
    })(e)),
      (Pt.index = -1),
      (Pt.loading = "live" === me.mode && e.length >= 3),
      jt(),
      Pt.loading &&
        (Pt.timer = setTimeout(
          () =>
            (async function (e) {
              Pt.ctl = new AbortController();
              try {
                const t = await (async function (e, t) {
                  const a = new URLSearchParams({
                    q: e,
                    activite_principale: "45.20A,45.20B,45.32Z,45.11Z",
                    etat_administratif: "A",
                    per_page: "10",
                    limite_matching_etablissements: "3",
                  });
                  me.place && me.place.dep && a.set("departement", me.place.dep);
                  const n = await F(
                    `https://recherche-entreprises.api.gouv.fr/search?${a}`,
                    { signal: t },
                    8e3,
                  );
                  if (!n.ok) throw new Error("sirene " + n.status);
                  const r = await n.json(),
                    s = [];
                  for (const e of r.results || []) {
                    const t =
                      e.matching_etablissements && e.matching_etablissements.length
                        ? e.matching_etablissements
                        : e.siege
                          ? [e.siege]
                          : [];
                    for (const a of t) {
                      if (!a || !a.siret || (a.etat_administratif && "A" !== a.etat_administratif)) continue;
                      const t =
                        (Array.isArray(a.liste_enseignes) && a.liste_enseignes[0]) ||
                        a.nom_commercial ||
                        e.nom_complet ||
                        e.nom_raison_sociale;
                      if (!t) continue;
                      const n = $(a.latitude),
                        r = $(a.longitude);
                      s.push({
                        id: "siret:" + a.siret,
                        name: q(t),
                        addr: q(a.adresse || ""),
                        lat: isFinite(n) ? n : null,
                        lon: isFinite(r) ? r : null,
                        chainId: (je({ name: t }) || {}).id || "",
                        src: "sirene",
                      });
                    }
                  }
                  return s;
                })(e, Pt.ctl.signal);
                if (Pt.garage.value.trim() !== e) return;
                const a = Pt.items,
                  n = t.filter(
                    (e) =>
                      !a.some(
                        (t) =>
                          t.id === e.id ||
                          (at(t.name, e.name) &&
                            Number.isFinite(t.lat) &&
                            Number.isFinite(e.lat) &&
                            _(t, e) < 0.15),
                      ),
                  );
                Pt.items = a.concat(n).slice(0, 12);
              } catch (e) {
                if (e && "AbortError" === e.name) return;
              }
              ((Pt.loading = !1), document.activeElement === Pt.garage && jt());
            })(e),
          350,
        )));
  }),
    Pt.garage.addEventListener("keydown", (e) => {
      const t = !Pt.gList.hidden,
        a = Pt.items.length;
      return "Escape" === e.key && t
        ? (e.preventDefault(), e.stopPropagation(), (Pt.listClosedAt = Date.now()), void zt())
        : "Enter" === e.key
          ? (e.preventDefault(), void (t && Pt.index >= 0 ? Nt(Pt.index) : (zt(), Pt.model.focus())))
          : void (
              t &&
              a &&
              ("ArrowDown" === e.key
                ? (e.preventDefault(), (Pt.index = (Pt.index + 1) % a), jt())
                : "ArrowUp" === e.key && (e.preventDefault(), (Pt.index = (Pt.index - 1 + a) % a), jt()))
            );
    }),
    Pt.gList.addEventListener("mousedown", (e) => e.preventDefault()),
    Pt.gList.addEventListener("click", (e) => {
      const t = e.target.closest("li[data-i]");
      t && Nt(+t.dataset.i);
    }),
    Pt.garage.addEventListener("blur", () => setTimeout(zt, 150)),
    wireVehicle());
  const Vt = ["", "Très mauvais", "Mauvais", "Correct", "Bien", "Excellent"],
    Gt = [...Pt.stars.querySelectorAll("label")];
  function Ht(e) {
    Gt.forEach((t, a) => t.classList.toggle("on", a < e));
  }
  function Wt(e) {
    ((Pt.rating = e),
      Ht(e),
      (Pt.rateWord.textContent = e ? `${e}/5 · ${Vt[e]}` : "Touchez une étoile"),
      Pt.rateWord.classList.toggle("set", !!e),
      e && Tt(Pt.stars, Pt.ratingErr, ""));
  }
  function Ot(e = {}) {
    Pt.form.reset();
    for (const [e, t] of [
      [Pt.garage, Pt.gErr],
      [Pt.model, Pt.modelErr],
      [Pt.plate, Pt.plateErr],
      [Pt.year, Pt.yearErr],
      [Pt.price, Pt.priceErr],
      [Pt.date, Pt.dateErr],
      [Pt.stars, Pt.ratingErr],
    ])
      Tt(e, t, "");
    (Bt(),
      zt(),
      Wt(0),
      (Pt.items = []),
      (Pt.picked = e.garage || null),
      (Pt.garage.value = e.garage ? e.garage.name : ""),
      Dt());
    const t = fe();
    ((Pt.service.value = e.svcId && "ct" !== e.svcId ? e.svcId : "ct" === t.kind ? "vidange" : t.id),
      (Pt.date.max = s),
      (Pt.date.value = s),
      vehPrefill(),
      (Pt.note.className = "dlg-note" + (Ye ? "" : " warn")),
      (Pt.note.textContent =
        "remote" === RS.mode
          ? "Elle est publiée sans votre nom : prix, mois, modèle, année et note sont visibles de tous sur la fiche du garage. Le commentaire n'est jamais publié (seule la modération peut le lire) ; l'immatriculation, envoyée pour repérer les doublons, n'est ni publiée ni conservée en clair." +
            (Ye ? "" : " Ce navigateur bloque l'enregistrement local : vous ne pourrez pas la retirer plus tard.")
          : Ye
            ? "Elle reste enregistrée dans ce navigateur et complète l'échelle de prix du garage concerné."
            : "Ce navigateur bloque l'enregistrement local : vos déclarations seront perdues à la fermeture de la page."),
      document.documentElement.classList.add("dlg-open"),
      "function" == typeof Pt.el.showModal ? Pt.el.showModal() : Pt.el.setAttribute("open", ""),
      (Pt.garage.value
        ? [Pt.model, Pt.plate, Pt.year, Pt.price].find((e) => !e.value.trim())
        : Pt.garage
      ).focus());
  }
  function Qt() {
    (Bt(),
      zt(),
      mdlHide(),
      "function" == typeof Pt.el.close ? Pt.el.open && Pt.el.close() : Pt.el.removeAttribute("open"),
      document.documentElement.classList.remove("dlg-open"));
  }
  function Kt() {
    me.raw.length && "osm" === me.kind && ht();
  }
  (Pt.stars.addEventListener("change", (e) => {
    "rRating" === e.target.name && Wt(+e.target.value);
  }),
    Pt.stars.addEventListener("mouseover", (e) => {
      const t = e.target.closest("label");
      t && Ht(+t.dataset.v);
    }),
    Pt.stars.addEventListener("mouseleave", () => Ht(Pt.rating)),
    Pt.price.addEventListener("input", () => Tt(Pt.price, Pt.priceErr, "")),
    Pt.date.addEventListener("input", () => (Tt(Pt.date, Pt.dateErr, ""), yearRecheck())),
    Pt.el.addEventListener("close", () => {
      (Bt(), document.documentElement.classList.remove("dlg-open"));
    }),
    Pt.el.addEventListener("cancel", (e) => {
      Date.now() - Pt.listClosedAt < 120 && e.preventDefault();
    }),
    w("#dlgClose").addEventListener("click", Qt),
    w("#dlgCancel").addEventListener("click", Qt),
    pe.addBtn.addEventListener("click", () => Ot()),
    Pt.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const t = Pt.picked,
        a = t ? t.name : q(Pt.garage.value),
        n = J(Pt.model.value),
        pl = plateMask(Pt.plate.value).value,
        yr = Pt.year.value.trim(),
        r = Pt.rating,
        i = Pt.price.value.trim(),
        o = $(i),
        l = Pt.date.value,
        ym = yearMsg(yr, l),
        c = [],
        d = (e, t, a, n) => {
          (Tt(t, a, e ? "" : n), e || c.push(t));
        };
      if (
        (d(a.length >= 2, Pt.garage, Pt.gErr, "Indiquez le garage concerné."),
        d(n.length >= 2, Pt.model, Pt.modelErr, "Indiquez le modèle du véhicule, par exemple Peugeot 208."),
        d(
          PLATE_RE.test(pl),
          Pt.plate,
          Pt.plateErr,
          pl ? PLATE_HELP : "Indiquez l'immatriculation du véhicule.",
        ),
        d(!ym, Pt.year, Pt.yearErr, ym),
        d(
          o >= PRICE_MIN && o <= PRICE_MAX,
          Pt.price,
          Pt.priceErr,
          i
            ? o > PRICE_MAX
              ? "Montant trop élevé : 20 000 € au maximum."
              : o > 0
                ? `Montant trop faible : ${PRICE_MIN} € au minimum.`
                : "Montant non reconnu. Exemple : 89,90"
            : "Indiquez le prix payé.",
        ),
        d(
          /^\d{4}-\d{2}-\d{2}$/.test(l) && l <= s && l >= "1990-01-01",
          Pt.date,
          Pt.dateErr,
          l
            ? l > s
              ? "La date ne peut pas être dans le futur."
              : "Date non reconnue."
            : "Indiquez la date de la réparation.",
        ),
        d(r >= 1 && r <= 5, Pt.stars, Pt.ratingErr, "Donnez une note au garage, de 1 à 5 étoiles."),
        c.length)
      )
        return void (c[0] === Pt.stars ? w("#rSt1") : c[0]).focus();
      const u = act(() => RS.add({
        garageId: t ? t.id : "custom:" + (tt(a).replace(/ /g, "-") || "garage"),
        garageName: a,
        garageAddr: (t && t.addr) || "",
        lat: t && Number.isFinite(t.lat) ? t.lat : null,
        lon: t && Number.isFinite(t.lon) ? t.lon : null,
        chainId: t ? t.chainId || "" : (je({ name: a }) || {}).id || "",
        model: n,
        immat: pl,
        year: +yr,
        rating: r,
        serviceId: Pt.service.value,
        price: Math.round(100 * o) / 100,
        date: l,
        comment: Pt.comment.value.trim().slice(0, 500),
        // point de recherche : sert à situer un garage saisi à la main (sans position) dans la base partagée
        area: me.place && !(t && Number.isFinite(t.lat)) ? { lat: me.place.lat, lon: me.place.lon } : undefined,
      }));
      (Qt(), Kt());
      // Si la recherche en cours contient ce garage, sa fiche s'ouvre sur l'échelle de prix et l'historique mis à jour.
      const g = "garages" === me.screen && "osm" === me.kind ? me.view.find((t) => nt(u, t)) : null;
      if (g) {
        _t(g.id, !0);
        const d = pe.list.querySelector(`details.history[data-hid="${CSS.escape(g.id)}"]`);
        d && (d.open = !0);
      }
      aa(
        `Réparation enregistrée : ${u.garageName}, ${C(u.price)}, ${r}/5. ${
          g
            ? u.serviceId === fe().id
              ? "Échelle de prix et note mises à jour."
              : "Note et historique du garage mis à jour."
            : "Elle s'affichera dans la fiche de ce garage."
        }`,
        { label: "Annuler", fn: () => unrepair(u.id, "Réparation annulée.", !1) },
      );
    }));
  // Retire une réparation déclarée depuis ce navigateur : « Annuler » du message d'enregistrement, « Supprimer » de
  // l'historique d'une fiche (avec « Annuler » pour la remettre).
  function unrepair(id, msg, undoable) {
    const removed = act(() => RS.remove(id));
    if (!removed) return;
    Kt();
    aa(
      msg,
      undoable
        ? {
            label: "Annuler",
            fn: () => {
              act(() => RS.restore(removed));
              Kt();
            },
          }
        : null,
    );
  }
  const Yt = ["garages", "prix"];
  function Zt(e) {
    Yt.includes(e) || (e = "garages");
    const t = me.screen !== e;
    ((me.screen = e), (document.body.dataset.screen = e));
    for (const t of Yt) w("#view-" + t).hidden = t !== e;
    for (const t of pe.tabs.querySelectorAll(".tab"))
      t.dataset.view === e ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current");
    ("garages" === e && (me.mapDirty ? Et() : Mt && Mt.invalidateSize()), t && window.scrollTo(0, 0));
  }
  (window.addEventListener("hashchange", () => Zt(location.hash.slice(1))),
    window.addEventListener("popstate", () => Zt(location.hash.slice(1))));
  let ta = null;
  function aa(e, t) {
    (clearTimeout(ta),
      (pe.toast.innerHTML = `<span>${y(e)}</span>${t ? `<button type="button">${y(t.label)}</button>` : ""}`),
      (pe.toast.hidden = !1),
      t &&
        pe.toast.querySelector("button").addEventListener("click", () => {
          ((pe.toast.hidden = !0), t.fn());
        }),
      (ta = setTimeout(
        () => {
          pe.toast.hidden = !0;
        },
        t ? 8e3 : 5e3,
      )));
  }
  function na() {
    P.set("jg.last.v1", {
      svc: pe.service.value,
      km: pe.radius.value,
      place: me.place,
      sirene: pe.sirene.checked,
    });
  }
  (pe.sirene.addEventListener("change", na),
    pe.service.addEventListener("change", () => {
      if ((ve(), na(), !me.raw.length)) return;
      const e = "ct" === fe().kind;
      e === ("ct" === me.kind)
        ? ht()
        : (pt(),
          Pe(!1),
          dt(
            e
              ? "Lancez la recherche pour charger les prix officiels du contrôle technique."
              : "Lancez la recherche pour afficher les garages.",
          ));
    }),
    (function () {
      const e = P.get("jg.last.v1", null);
      (e
        ? (e.svc && o.some((t) => t.id === e.svc) && (pe.service.value = e.svc),
          e.km && (pe.radius.value = e.km),
          e.place &&
            isFinite(e.place.lat) &&
            ((me.place = e.place), (pe.address.value = e.place.label || "")),
          (pe.sirene.checked = !!e.sirene))
        : (pe.service.value = "geo_av"),
        _e(),
        ve(),
        Zt(location.hash.slice(1) || "garages"),
        (function () {
          if (!me.place || "ct" === fe().kind) return;
          const e = Ie(me.place.lat, me.place.lon, Math.round(1e3 * +pe.radius.value));
          e &&
            ((me.raw = me.garages = e.els.map(Be).filter(Boolean)),
            (me.kind = "osm"),
            (me.fetchedKm = +pe.radius.value),
            (me.shown = r),
            (me.cachedAt = e.t),
            // la dernière réponse connue pour cette zone est déjà là : le premier affichage comprend les réparations d'autres
            RS.preload({ lat: me.place.lat, lon: me.place.lon, km: +pe.radius.value }),
            Pe(!0),
            ht(),
            RS.load({ lat: me.place.lat, lon: me.place.lon, km: +pe.radius.value }).catch(() => {}));
        })(),
        (me.probe = we()));
    })());
  // Ce que le magasin signale de lui-même : réparations arrivées (zone chargée, envoi terminé), état du service, avis.
  function storeNotice(e) {
    const where = e.row ? `${e.row.garageName}, ${C(e.row.price)}` : "",
      why = e.fields && Object.keys(e.fields).length ? ` (${Object.values(e.fields).join(" ; ")})` : "",
      msg = {
        duplicate: `Cette réparation (${where}) avait déjà été déclarée : elle n'est comptée qu'une fois.`,
        rejected: `Cette réparation (${where}) n'a pas pu être partagée${why}. Elle reste sur cet appareil.`,
        gaveup: `Une réparation (${where}) n'a pas pu être envoyée depuis plus d'une semaine. Elle reste sur cet appareil.`,
      }[e.kind]; // « queued » : l'encart « en attente d'envoi » s'en charge, sans remplacer le message « Annuler »
    msg && aa(msg);
  }
  // L'état d'envoi d'une réparation change (envoyée, gardée ici, en relecture) : on met son étiquette à jour, sans tout réafficher.
  function refreshRowState(id) {
    const row = Ze.find((r) => r.id === id),
      label = row ? stateLabel(Y(row)) : "";
    for (const btn of pe.list.querySelectorAll(`.h-del[data-rid="${CSS.escape(id)}"]`)) {
      const host = btn.parentElement,
        old = host.querySelector(".h-state");
      if (!label) old && old.remove();
      else if (old) old.textContent = label;
      else {
        const tag = document.createElement("span");
        tag.className = "h-state";
        tag.textContent = label;
        host.insertBefore(tag, btn);
      }
    }
  }
  RS.on((e) => {
    if ("row" === e.type) refreshRowState(e.id);
    else if ("rows" === e.type) quiet || Kt();
    else if ("sync" === e.type) renderRepairNote();
    else if ("notice" === e.type) storeNotice(e);
  });
  RS.attach(window);
})();
