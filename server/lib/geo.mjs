// Cases géographiques de 0,05° (≈ 5,5 km en latitude) : de quoi interroger « tout ce qui est autour de ce point »
// avec un index ordinaire, sans extension PostGIS.
export const CELL_DEG = 0.05;
export const RADII_KM = [3, 5, 10, 20, 30, 50];

export const cellOf = (lat, lon) => ({ y: Math.floor((lat + 90) / CELL_DEG), x: Math.floor((lon + 180) / CELL_DEG) });

export function cellsAround(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  const lo = cellOf(Math.max(-90, lat - dLat), Math.max(-180, lon - dLon));
  const hi = cellOf(Math.min(90, lat + dLat), Math.min(180, lon + dLon));
  return { y0: lo.y, y1: hi.y, x0: lo.x, x1: hi.x };
}
