// Mocks for every external service the Juste Garage page talks to, so the page
// can be exercised end-to-end in a sandbox without network access.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CENTER = { lat: 45.764, lon: 4.8357 }; // 12 rue de la République, Lyon 2e

// ---------- deterministic PRNG ----------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- OSM / Overpass mock ----------
function buildElements(count = 62) {
  const rnd = mulberry32(42);
  const chains = [
    ["Norauto", "Q3317698", "car_repair"],
    ["Speedy", "Q3492969", "car_repair"],
    ["Feu Vert", "Q3070922", "car_repair"],
    ["Midas", "Q3312613", "car_repair"],
    ["Roady", "Q3434112", "tyres"],
    ["Euromaster", "Q3060668", "tyres"],
    ["Point S", "Q3393358", "tyres"],
    ["Vulco", "Q80184403", "tyres"],
    ["First Stop", "Q3072965", "tyres"],
    ["Bosch Car Service", "Q894368", "car_repair"],
    ["Carter-Cash", null, "tyres"],
  ];
  const towns = [
    "Lyon 7e", "Villeurbanne", "Vénissieux", "Bron", "Caluire-et-Cuire", "Décines-Charpieu",
    "Saint-Priest", "Vaulx-en-Velin", "Lyon 3e", "Lyon 8e", "Lyon 9e", "Oullins", "Meyzieu",
  ];
  const indep = [
    "Garage Martin & Fils", "Auto Plus Lyon", "Garage de la Guillotière", "Atelier Mécanique du Rhône",
    "Garage Dubois", "Pneus Express", "Mécanique Générale Perrache", "Garage du Parc", "Auto Services Part-Dieu",
    "Garage Bellecour Automobiles", "SARL Duchamp Auto", "Garage Lumière", "Auto Expert Gerland",
    "Société Nouvelle d'Entretien et de Réparation Automobile du Grand Lyon Sud-Est (SNERA)",
    "Garage Sainte-Foy", "Atelier 69", "Garage Croix-Rousse", "Réparauto Confluence",
  ];
  const els = [];
  let id = 1000;
  const mk = (tags, extra = {}) => {
    // distance 0.3 – 9.4 km, any bearing
    const d = 0.3 + rnd() * 9.1;
    const th = rnd() * Math.PI * 2;
    const lat = CENTER.lat + (d * Math.cos(th)) / 111.2;
    const lon = CENTER.lon + (d * Math.sin(th)) / (111.2 * Math.cos((CENTER.lat * Math.PI) / 180));
    const base = { type: "node", id: id++, lat, lon, tags };
    return Object.assign(base, extra);
  };
  const phone = () => `+33 4 7${Math.floor(rnd() * 9) + 1} ${String(Math.floor(rnd() * 90) + 10)} ${String(Math.floor(rnd() * 90) + 10)} ${String(Math.floor(rnd() * 90) + 10)}`;
  const hours = ["Mo-Fr 08:00-18:30; Sa 08:00-12:30", "Mo-Sa 08:30-19:00", "Mo-Fr 08:00-12:00,14:00-18:00", "Mo-Su 09:00-19:00; PH off"];
  const street = ["rue Garibaldi", "avenue Jean Jaurès", "cours Gambetta", "route de Genas", "rue Marcel Mérieux", "boulevard des États-Unis", "avenue Berthelot", "rue Paul Bert", "quai Perrache", "avenue Franklin Roosevelt"];
  const pc = ["69007", "69100", "69200", "69500", "69300", "69150", "69800", "69120", "69003", "69008", "69009", "69600", "69330"];

  // chains
  for (let i = 0; i < 24; i++) {
    const [name, wd, shop] = chains[i % chains.length];
    const t = towns[Math.floor(rnd() * towns.length)];
    const tags = {
      name: `${name} ${t}`,
      brand: name,
      shop,
      phone: phone(),
      opening_hours: hours[Math.floor(rnd() * hours.length)],
      "addr:housenumber": String(Math.floor(rnd() * 150) + 1),
      "addr:street": street[Math.floor(rnd() * street.length)],
      "addr:postcode": pc[Math.floor(rnd() * pc.length)],
      "addr:city": t.replace(/ \d+e$/, ""),
      website: `https://www.${name.toLowerCase().replace(/[^a-z]/g, "")}.fr/centres/${i}`,
    };
    if (wd) tags["brand:wikidata"] = wd;
    if (i % 3 === 0) tags["service:vehicle:wheel_alignment"] = "yes";
    els.push(mk(tags));
  }
  // independents
  for (let i = 0; i < count - 24; i++) {
    const name = indep[i % indep.length] + (i >= indep.length ? ` ${Math.floor(i / indep.length) + 1}` : "");
    const t = towns[Math.floor(rnd() * towns.length)];
    const tags = {
      name,
      shop: i % 7 === 3 ? "tyres" : "car_repair",
      "addr:housenumber": String(Math.floor(rnd() * 150) + 1),
      "addr:street": street[Math.floor(rnd() * street.length)],
      "addr:postcode": pc[Math.floor(rnd() * pc.length)],
      "addr:city": t.replace(/ \d+e$/, ""),
    };
    if (rnd() > 0.35) tags.phone = phone();
    if (rnd() > 0.5) tags.opening_hours = hours[Math.floor(rnd() * hours.length)];
    if (rnd() > 0.6) tags.website = `https://garage-${i}.example.fr`;
    if (i % 4 === 0) tags["service:vehicle:wheel_alignment"] = "yes";
    if (i % 5 === 1) tags["service:vehicle:oil_change"] = "yes";
    els.push(mk(tags));
  }
  // special cases
  els.push(mk({ name: "Carrosserie Bernard", shop: "car_repair", "addr:city": "Lyon", phone: phone() }));
  els.push(mk({ name: "Renault Retail Group Lyon", brand: "Renault", shop: "car_repair", "addr:city": "Lyon", phone: phone(), opening_hours: hours[0] }));
  els.push(mk({ shop: "car_repair", "addr:city": "Lyon" }));
  // tiny odd one using `center`
  els.push({ type: "way", id: id++, center: { lat: CENTER.lat + 0.01, lon: CENTER.lon + 0.012 }, tags: { name: "GARAGE DU PONT (way)", shop: "car_repair" } });
  return els;
}

const ADDRESS_FEATURES = {
  lyon: [
    {
      type: "Feature",
      properties: { label: "12 Rue de la République 69002 Lyon", type: "housenumber", city: "Lyon", postcode: "69002", context: "69, Rhône, Auvergne-Rhône-Alpes", citycode: "69382" },
      geometry: { type: "Point", coordinates: [CENTER.lon, CENTER.lat] },
    },
    {
      type: "Feature",
      properties: { label: "Lyon", type: "municipality", city: "Lyon", postcode: "69001", context: "69, Rhône, Auvergne-Rhône-Alpes", citycode: "69123" },
      geometry: { type: "Point", coordinates: [4.8357, 45.7578] },
    },
    {
      type: "Feature",
      properties: { label: "Rue de Lyon 75012 Paris", type: "street", city: "Paris", postcode: "75012", context: "75, Paris, Île-de-France", citycode: "75112" },
      geometry: { type: "Point", coordinates: [2.3727, 48.8498] },
    },
  ],
};

// ---------- tile generator (pseudo "Plan IGN": beige, yellow roads, green, water) ----------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const tileCache = new Map();
function tilePNG(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const W = 256;
  const rgb = Buffer.alloc(W * W * 3);
  const rnd = mulberry32((x * 73856093) ^ (y * 19349663) ^ (z * 83492791));
  const fill = (x0, y0, x1, y1, col) => {
    const [r, g, b] = hex(col);
    for (let yy = Math.max(0, y0 | 0); yy < Math.min(W, y1 | 0); yy++)
      for (let xx = Math.max(0, x0 | 0); xx < Math.min(W, x1 | 0); xx++) {
        const o = (yy * W + xx) * 3;
        rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
      }
  };
  fill(0, 0, W, W, "#F1EDE4");
  // blocks (grid of streets)
  const cols = 3 + Math.floor(rnd() * 3), rows = 3 + Math.floor(rnd() * 3);
  const cw = W / cols, rh = W / rows;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x0 = c * cw + 8, y0 = r * rh + 8, x1 = (c + 1) * cw - 8, y1 = (r + 1) * rh - 8;
      const t = rnd();
      if (t < 0.14) fill(x0 - 4, y0 - 4, x1 + 4, y1 + 4, "#CFE3BE"); // park
      else {
        fill(x0, y0, x1, y1, "#E2DCD0");
        // building footprints
        const n = 2 + Math.floor(rnd() * 4);
        for (let k = 0; k < n; k++) {
          const bx = x0 + 3 + rnd() * (x1 - x0 - 24), by = y0 + 3 + rnd() * (y1 - y0 - 24);
          fill(bx, by, bx + 10 + rnd() * 14, by + 8 + rnd() * 12, "#D3CCC0");
        }
      }
    }
  // streets: casing + white fill
  for (let c = 0; c <= cols; c++) fill(c * cw - 6, 0, c * cw + 6, W, "#E7CE74");
  for (let r = 0; r <= rows; r++) fill(0, r * rh - 6, W, r * rh + 6, "#E7CE74");
  for (let c = 0; c <= cols; c++) fill(c * cw - 4, 0, c * cw + 4, W, "#FFFFFF");
  for (let r = 0; r <= rows; r++) fill(0, r * rh - 4, W, r * rh + 4, "#FFFFFF");
  // water band on some tiles
  if (rnd() < 0.18) {
    const [wr, wg, wb] = hex("#A9D3F0");
    const k = 40 + rnd() * 170;
    for (let yy = 0; yy < W; yy++)
      for (let xx = 0; xx < W; xx++)
        if (Math.abs(xx + yy * 0.35 - k) < 22) {
          const o = (yy * W + xx) * 3;
          rgb[o] = wr; rgb[o + 1] = wg; rgb[o + 2] = wb;
        }
  }
  const out = encodePNG(W, W, rgb);
  tileCache.set(key, out);
  return out;
}


// ---------- stand-in logos (RGBA, transparent background) ----------
function encodePNGA(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const LOGO_COLORS = { norauto: "#E2001A", speedy: "#FFD400", midas: "#C8102E", point: "#0057B8", vulco: "#00843D", bosch: "#E20015", default: "#4A3FDB" };
function logoPNG(name) {
  const n = String(name).toLowerCase();
  const key = Object.keys(LOGO_COLORS).find((k) => n.includes(k)) || "default";
  const col = hex(LOGO_COLORS[key]);
  const wide = n.includes("wide") || n.includes("speedy");
  const W = 128, H = wide ? 36 : 128;
  const px = Buffer.alloc(W * H * 4); // fully transparent
  const put = (x, y, c, a = 255) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = a; };
  if (wide) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, col);
    for (const [x0, x1] of [[10, 34], [44, 68], [78, 118]]) for (let y = 9; y < 27; y++) for (let x = x0; x < x1; x++) put(x, y, [17, 19, 21]);
  } else if (n.includes("icon")) {
    for (let y = 8; y < 120; y++) for (let x = 8; x < 120; x++) { const dx = Math.min(x - 8, 119 - x), dy = Math.min(y - 8, 119 - y); if (dx + dy > 10 || (dx > 14 || dy > 14)) put(x, y, col); }
    for (let y = 40; y < 88; y++) for (let x = 40; x < 88; x++) put(x, y, [255, 255, 255]);
  } else {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = Math.hypot(x - 63.5, y - 63.5); if (d < 58) put(x, y, d > 40 ? col : [255, 255, 255]); }
    for (let y = 52; y < 76; y++) for (let x = 28; x < 100; x++) put(x, y, col);
  }
  return encodePNGA(W, H, px);
}


function iconPNG(size, colorHex = "#4A3FDB") {
  const col = hex(colorHex), px = Buffer.alloc(size * size * 4);
  const put = (x, y, c) => { const o = (y * size + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, col);
  const a = Math.floor(size * 0.3), z = Math.ceil(size * 0.7);
  for (let y = a; y < z; y++) for (let x = a; x < z; x++) put(x, y, [255, 255, 255]);
  return encodePNGA(size, size, px);
}
// .ico container with one PNG frame per size (what real sites ship as /favicon.ico)
function icoFile(sizes, colorHex) {
  const pngs = sizes.map((s) => iconPNG(s, colorHex));
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = 6 + 16 * sizes.length;
  const dirs = sizes.map((s, i) => { const d = Buffer.alloc(16); d[0] = s >= 256 ? 0 : s; d[1] = s >= 256 ? 0 : s; d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6); d.writeUInt32LE(pngs[i].length, 8); d.writeUInt32LE(off, 12); off += pngs[i].length; return d; });
  return Buffer.concat([head, ...dirs, ...pngs]);
}

// ---------- CT mock (prix-controle-technique) ----------
function ctRows() {
  const rnd = mulberry32(7);
  const names = ["AUTOSUR LYON GERLAND", "DEKRA LYON 7", "SECURITEST VILLEURBANNE", "AUTOVISION BRON", "CONTROLE AUTO DU RHONE", "NORISKO VENISSIEUX", "VERIF'AUTO DECINES", "AUTO SECURITE LYON 3"];
  const rows = [];
  names.forEach((n, i) => {
    const d = 0.8 + rnd() * 8, th = rnd() * 6.28;
    const lat = CENTER.lat + (d * Math.cos(th)) / 111.2, lon = CENTER.lon + (d * Math.sin(th)) / 78;
    for (const [en, pr] of [["Essence", 69 + Math.floor(rnd() * 25)], ["Diesel", 74 + Math.floor(rnd() * 25)], ["Electrique", 79 + Math.floor(rnd() * 20)]]) {
      rows.push({
        cct_siret: "8123456780" + (10 + i), cct_denomination: n, cct_adresse: `${10 + i * 7} avenue du Test`, cct_code_postal: "69007", cct_commune: "LYON",
        cct_tel: "04 72 00 00 0" + i, cct_url: "", latitude: lat, longitude: lon,
        cat_vehicule_id: 1, cat_vehicule_libelle: "Véhicule particulier", cat_energie_id: 1, cat_energie_libelle: en,
        prix_visite: pr, prix_contre_visite_mini: 15, prix_contre_visite_maxi: 25, date_application_visite: "2026-03-01",
      });
    }
  });
  return rows;
}

// ---------- installer ----------
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
async function installMocks(ctx, opts = {}) {
  const log = opts.log || (() => {});
  const fonts = (key) => fs.readFileSync(path.join(__dirname, "fixtures", "fonts", key));
  const elements = opts.elements || buildElements();
  const counters = (ctx.__counters = { overpass: 0, geocode: 0, tiles: 0, ct: 0, sirene: 0, wikidata: 0, upload: 0, logoFiles: [], siteIcons: [], sparql: "", other: [], reverse: 0, reverseUrls: [] });

  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const h = url.hostname;
    if (h === "127.0.0.1" || h === "localhost") {
      // site publiable (dist/) : Leaflet se charge d'abord depuis le site ; on y ajoute la même instrumentation que celle du CDN simulé
      if (/\/assets\/leaflet\.[0-9a-f]+\.js$/.test(url.pathname)) {
        const response = await route.fetch();
        return route.fulfill({ response, body: (await response.text()) + "\n;L.Map.addInitHook(function(){(window.__maps=window.__maps||[]).push(this)});" });
      }
      return route.continue();
    }

    // Google Fonts -> local files
    if (h === "fonts.googleapis.com") {
      const fam = (url.searchParams.get("family") || "").toLowerCase();
      const key = fam.includes("jakarta") ? "pjs" : fam.includes("barlow") ? null : "inter";
      if (!key) {
        // original page asks for Barlow: serve the real files so "before" screenshots are faithful
        return route.fulfill({ status: 200, contentType: "text/css", headers: CORS, body: fs.readFileSync(path.join(__dirname, "fixtures/fonts/barlow.css"), "utf8") });
      }
      const css = `
@font-face{font-family:'Plus Jakarta Sans';font-style:normal;font-weight:200 800;font-display:swap;src:url(https://fonts.gstatic.com/local/pjs-latin-ext.woff2) format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:'Plus Jakarta Sans';font-style:normal;font-weight:200 800;font-display:swap;src:url(https://fonts.gstatic.com/local/pjs-latin.woff2) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`;
      return route.fulfill({ status: 200, contentType: "text/css", headers: CORS, body: css });
    }
    if (h === "fonts.gstatic.com") {
      const m = url.pathname.match(/local\/((?:pjs-latin(?:-ext)?|barlow-\d+)\.woff2)/);
      if (m) return route.fulfill({ status: 200, contentType: "font/woff2", headers: CORS, body: fonts(m[1]) });
      return route.fulfill({ status: 404, body: "" });
    }
    if (h === "fonts.googleapis.com" || h === "fonts.gstatic.com") return route.abort();

    // Leaflet from local node_modules
    if (h === "cdnjs.cloudflare.com" && url.pathname.endsWith("leaflet.js"))
      return route.fulfill({
        status: 200, contentType: "application/javascript", headers: CORS,
        body: fs.readFileSync(path.join(__dirname, "..", "node_modules/leaflet/dist/leaflet.js")) +
          "\n;L.Map.addInitHook(function(){(window.__maps=window.__maps||[]).push(this)});",
      });

    // IGN geocoder
    if (h === "data.geopf.fr" && url.pathname.startsWith("/geocodage/search")) {
      counters.geocode++;
      if (opts.geocodeFail) return route.abort();
      const q = (url.searchParams.get("q") || "").toLowerCase();
      let feats = ADDRESS_FEATURES.lyon.filter((f) => (f.properties.label + " " + f.properties.city).toLowerCase().includes(q.split(" ")[0]) || q.includes("lyon"));
      if (!feats.length) feats = [];
      const limit = +(url.searchParams.get("limit") || 5);
      return route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ type: "FeatureCollection", features: feats.slice(0, limit) }) });
    }
    // IGN reverse geocoder (Géoplateforme): nearest address to a point.
    // opts.reverse = { offsetM, delayMs, fail, failAt(lat, lon) -> boolean, empty, noDistance, noGeometry, label, city, postcode, noCity, at(lat, lon) -> overrides }
    // counters.reverseMax = most requests in flight at once
    if (h === "data.geopf.fr" && url.pathname.startsWith("/geocodage/reverse")) {
      counters.reverse++; counters.reverseUrls.push(url.search);
      counters.reverseNow = (counters.reverseNow || 0) + 1;
      counters.reverseMax = Math.max(counters.reverseMax || 0, counters.reverseNow);
      try {
        const mode = opts.reverse || {};
        if (mode.delayMs) await new Promise((r) => setTimeout(r, mode.delayMs));
        const lon = +url.searchParams.get("lon"), lat = +url.searchParams.get("lat");
        if (mode.fail || (mode.failAt && mode.failAt(lat, lon))) return await route.fulfill({ status: 503, headers: CORS, body: "" });
        const mo = { ...mode, ...(mode.at ? mode.at(lat, lon) || {} : {}) };
        const json = (o) => route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(o) });
        if (mode.empty) return await json({ type: "FeatureCollection", features: [] });
        const off = mo.offsetM == null ? 14 : mo.offsetM, n = 1 + (Math.round(lat * 1e4) % 97), pc = mo.postcode || "69007", city = mo.city || "Lyon";
        const props = { label: mo.label || `${n} Rue du Test ${pc} ${city}`, name: mo.label ? mo.label.split(" 6")[0] : `${n} Rue du Test`, housenumber: String(n), street: "Rue du Test", postcode: pc, city, type: "housenumber" };
        if (mo.noCity) delete props.city;
        if (!mode.noDistance) props.distance = Math.round(off);
        const feature = { type: "Feature", properties: props };
        if (!mode.noGeometry) feature.geometry = { type: "Point", coordinates: [lon, lat + off / 111200] };
        return await json({ type: "FeatureCollection", features: [feature] });
      } finally { counters.reverseNow--; }
    }
    // IGN tiles
    if (h === "data.geopf.fr" && url.pathname.startsWith("/wmts")) {
      counters.tiles++;
      const z = +url.searchParams.get("TILEMATRIX"), y = +url.searchParams.get("TILEROW"), x = +url.searchParams.get("TILECOL");
      return route.fulfill({ status: 200, contentType: "image/png", headers: CORS, body: tilePNG(z, x, y) });
    }
    if (h.endsWith("basemaps.cartocdn.com")) {
      counters.tiles++;
      const m = url.pathname.match(/\/(\d+)\/(\d+)\/(\d+)/);
      return route.fulfill({ status: 200, contentType: "image/png", headers: CORS, body: tilePNG(+m[1], +m[2], +m[3]) });
    }
    // Wikidata (logos) -> SPARQL, then Commons Special:FilePath (302) -> upload.wikimedia.org (png)
    if (h === "query.wikidata.org") {
      counters.wikidata++;
      counters.sparql = url.searchParams.get("query") || "";
      if (opts.wikidataFail) return route.abort();
      if (opts.wikidataDelay) await new Promise((r) => setTimeout(r, opts.wikidataDelay));
      const bindings = (opts.logos || []).map((e) => {
        const b = {
          item: { type: "uri", value: "http://www.wikidata.org/entity/" + e.q },
          kind: { type: "literal", datatype: "http://www.w3.org/2001/XMLSchema#integer", value: String(e.kind) },
          val: { type: "uri", value: e.raw || "http://commons.wikimedia.org/wiki/Special:FilePath/" + encodeURIComponent(e.file) },
        };
        if (e.start) b.start = { type: "literal", datatype: "http://www.w3.org/2001/XMLSchema#dateTime", value: e.start };
        return b;
      });
      for (const s of opts.sites || []) bindings.push({ item: { type: "uri", value: "http://www.wikidata.org/entity/" + s.q }, kind: { type: "literal", datatype: "http://www.w3.org/2001/XMLSchema#integer", value: "9" }, val: { type: "uri", value: s.url } });
      return route.fulfill({ status: 200, contentType: "application/sparql-results+json", headers: CORS, body: JSON.stringify({ head: { vars: ["item", "kind", "val", "start"] }, results: { bindings } }) });
    }
    if (h === "commons.wikimedia.org" && url.pathname.startsWith("/wiki/Special:FilePath/")) {
      const name = decodeURIComponent(url.pathname.slice("/wiki/Special:FilePath/".length));
      counters.logoFiles.push(name + "?" + url.searchParams.toString());
      if ((opts.logo404 || []).includes(name)) return route.fulfill({ status: 404, headers: CORS, body: "" });
      counters.upload++; // (the real service answers 302 -> upload.wikimedia.org; Playwright cannot re-intercept redirects)
      return route.fulfill({ status: 200, contentType: "image/png", headers: CORS, body: logoPNG(name) });
    }
    if (h === "upload.wikimedia.org") {
      counters.upload++;
      const name = decodeURIComponent(url.pathname.split("/").pop().replace(/^128px-/, ""));
      return route.fulfill({ status: 200, contentType: "image/png", headers: CORS, body: logoPNG(name) });
    }
    // Official-site icons (tier 2): nothing there in routed mode (Playwright also drops */favicon.ico while a route is
    // active; the logo tests use the real HTTPS server of harness.js instead, see open(..., { real: true }))
    if (url.pathname === "/apple-touch-icon.png" || url.pathname === "/favicon.ico") {
      counters.siteIcons.push(h + url.pathname);
      return route.fulfill({ status: 404, headers: CORS, body: "" });
    }
    // Overpass
    if (h.includes("overpass")) {
      counters.overpass++;
      if (opts.overpassDelayMs) await new Promise((r) => setTimeout(r, opts.overpassDelayMs)); // a slow server: the loading state stays on screen
      if (opts.overpassFail) return route.fulfill({ status: 504, headers: CORS, body: "" });
      return route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ version: 0.6, elements }) });
    }
    // SIRENE
    if (h === "recherche-entreprises.api.gouv.fr") {
      counters.sirene++;
      if (opts.sireneFail) return route.fulfill({ status: 500, headers: CORS, body: "" });
      // opts.sireneItems: [{ siret, name, lat, lon, adresse }] -> companies with their établissements (NAF 45.20A)
      const results = (opts.sireneItems || []).map((it) => ({
        nom_complet: it.name, activite_principale: "45.20A",
        matching_etablissements: [{ siret: it.siret, latitude: it.lat, longitude: it.lon, adresse: it.adresse || "", etat_administratif: "A", activite_principale: "45.20A", liste_enseignes: [it.name] }],
      }));
      return route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ results, total_pages: 1, total_results: results.length }) });
    }
    // Contrôle technique
    if (h === "data.economie.gouv.fr") {
      counters.ct++;
      return route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(ctRows()) });
    }
    // anything else: record + block
    counters.other.push(url.href.slice(0, 140));
    log("blocked external:", url.href.slice(0, 120));
    return route.abort();
  });
}

module.exports = { installMocks, buildElements, CENTER, tilePNG, logoPNG, iconPNG, icoFile };
