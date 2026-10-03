// Journal : une ligne JSON par événement sur la sortie standard (Node, conteneur ou CloudWatch Logs). Ni adresse IP, ni requête, ni corps.
// LOG_LEVEL : « info » (une ligne par requête, par défaut), « warn » (incidents seulement), « error ».
const LEVELS = { error: 0, warn: 1, info: 2 };
export const jsonLog = (min) => (o) => (LEVELS[o.level] ?? 2) <= (LEVELS[min] ?? 2) && console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
