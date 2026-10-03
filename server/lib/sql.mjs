// Découpe d'un fichier de migration en instructions, et adaptation de chacune à Amazon Aurora DSQL.
// Ce n'est pas un analyseur SQL complet : il connaît les commentaires (-- et /* */), les chaînes '…' et identifiants "…" (guillemet
// doublé compris) et les blocs $tag$…$tag$, ce qui suffit à ne jamais couper sur un « ; » qui n'est pas une fin d'instruction.

export function splitStatements(sql) {
  const out = [];
  let cur = "";
  const push = () => {
    const s = cur.trim();
    if (s) out.push(s);
    cur = "";
  };
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === "-" && d === "-") {
      while (i < n && sql[i] !== "\n") i++; // commentaire de ligne : ignoré
      continue;
    }
    if (c === "/" && d === "*") {
      let depth = 1; // les commentaires de bloc s'imbriquent en PostgreSQL
      i += 2;
      while (i < n && depth) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      cur += " ";
      continue;
    }
    if (c === "'" || c === '"') {
      cur += c;
      i++;
      while (i < n) {
        cur += sql[i];
        if (sql[i] === c) {
          if (sql[i + 1] === c) { cur += sql[i + 1]; i += 2; continue; } // guillemet doublé : on reste dans la chaîne
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64)); // « $1 » (paramètre) ne correspond pas
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end === -1 ? n : end + m[0].length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      push();
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  push();
  return out;
}

// Position du premier WHERE hors parenthèses (celui d'un index partiel), ou -1.
function topLevelWhere(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && /\s/.test(c) && /^\s+WHERE\s/i.test(text.slice(i, i + 8))) return i;
  }
  return -1;
}

/**
 * Une instruction de structure, adaptée à DSQL :
 *  - CREATE TABLE x            → CREATE TABLE IF NOT EXISTS x              (relancer après un échec partiel reste possible)
 *  - CREATE [UNIQUE] INDEX x … → CREATE [UNIQUE] INDEX ASYNC IF NOT EXISTS x … sans ASC / DESC (DSQL ne les accepte pas)
 * Les autres instructions sont rendues telles quelles.
 */
export function toDsqlStatement(statement) {
  const s = statement.trim();
  if (/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(s)) return s.replace(/^CREATE\s+TABLE\s+/i, "CREATE TABLE IF NOT EXISTS ");
  const m = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:ASYNC\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w$]*)\s+ON\s+/i.exec(s);
  if (m) {
    const rest = s.slice(m[0].length);
    const w = topLevelWhere(rest);
    const head = (w === -1 ? rest : rest.slice(0, w)).replace(/\s+(ASC|DESC)\b/gi, "");
    return `CREATE ${m[1] ? "UNIQUE " : ""}INDEX ASYNC IF NOT EXISTS ${m[2]} ON ${head}${w === -1 ? "" : rest.slice(w)}`;
  }
  return s;
}

export const isIndexStatement = (statement) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(statement.trim());
