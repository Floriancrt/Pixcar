// ----- Téléphones : un garage peut en avoir plusieurs (fixe, mobile) et OpenStreetMap les saisit de dix façons -----
// phoneParse lit une valeur brute (plusieurs numéros séparés par « ; », « , », « / », « ou » ou « et »), ne garde que ce
// qui ressemble à un numéro, écrit les numéros français à la française (« 04 72 55 34 57 »), supprime les doublons et
// fournit le lien tel: international (« +33472553457 »). Un numéro qui n'est pas reconnu est ignoré, jamais deviné.
export function phoneParse(raw) {
  const out = [],
    seen = new Set();
  for (const part of String(raw || "").split(/\s*(?:[;,/|]|\bou\b|\bet\b)\s*/i)) {
    const m = part.replace(/\(\s*0\s*\)/g, " ").match(/(\+|00)?[\s(]*\d[\d\s().-]*\d/);
    if (!m) continue;
    let d = m[0].replace(/\D/g, ""),
      text,
      tel;
    if ("00" === m[1]) d = d.slice(2);
    if (m[1]) {
      if (d.startsWith("33")) {
        d = d.slice(2).replace(/^0/, "");
        if (9 !== d.length) continue;
        d = "0" + d;
      } else if (d.length < 10 || d.length > 15) continue;
      else {
        tel = "+" + d;
        text =
          "+" +
          m[0]
            .replace(/^(\+|00)[\s(]*/, "")
            .replace(/[().-]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
      }
    }
    if (!tel) {
      if (!/^0[1-9]\d{8}$/.test(d)) continue;
      tel = "+33" + d.slice(1);
      text = d.replace(/(\d{2})(?=\d)/g, "$1 ");
    }
    seen.has(tel) || (seen.add(tel), out.push({ text, tel }));
  }
  return out;
}
export const phoneList = (g) => phoneParse(g && g.phone);
