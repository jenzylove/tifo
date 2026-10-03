// Team colours for the split banner. Known clubs and national teams get their real colours;
// anything else gets a stable colour from its name. If both sides land too close, side B
// switches to its alternate so the two halves always read as two different teams.
const KNOWN: Record<string, [string, string]> = {
  arsenal: ["#EF0107", "#063672"],
  "aston villa": ["#670E36", "#95BFE5"],
  bournemouth: ["#DA291C", "#000000"],
  brentford: ["#E30613", "#FBB800"],
  brighton: ["#0057B8", "#FFCD00"],
  chelsea: ["#034694", "#DBA111"],
  "crystal palace": ["#1B458F", "#C4122E"],
  everton: ["#003399", "#FFFFFF"],
  fulham: ["#CC0000", "#000000"],
  ipswich: ["#0044A9", "#DE2C37"],
  leeds: ["#FFCD00", "#1D428A"],
  liverpool: ["#C8102E", "#00B2A9"],
  "manchester city": ["#6CABDD", "#1C2C5B"],
  "manchester united": ["#DA291C", "#FBE122"],
  newcastle: ["#241F20", "#41B6E6"],
  "nottingham forest": ["#DD0000", "#FFFFFF"],
  sunderland: ["#EB172B", "#211E1F"],
  tottenham: ["#132257", "#FFFFFF"],
  "west ham": ["#7A263A", "#1BB1E7"],
  wolverhampton: ["#FDB913", "#231F20"],
  coventry: ["#59CBE8", "#FFFFFF"],
  hull: ["#F5A12D", "#000000"],
  "real madrid": ["#FEBE10", "#00529F"],
  barcelona: ["#A50044", "#004D98"],
  "atletico": ["#CB3524", "#272E61"],
  bayern: ["#DC052D", "#0066B2"],
  dortmund: ["#FDE100", "#000000"],
  juventus: ["#1A1A1A", "#FFFFFF"],
  inter: ["#0068A8", "#1A1A1A"],
  milan: ["#FB090B", "#000000"],
  napoli: ["#12A0D7", "#FFFFFF"],
  "paris saint-germain": ["#004170", "#DA291C"],
  seattle: ["#5D9741", "#005595"],
  "sporting kansas city": ["#93B1D7", "#002F65"],
  france: ["#002395", "#ED2939"],
  italy: ["#0066CC", "#FFFFFF"],
  england: ["#FFFFFF", "#CF081F"],
  spain: ["#AA151B", "#F1BF00"],
  germany: ["#000000", "#DD0000"],
  portugal: ["#006600", "#FF0000"],
  netherlands: ["#FF6F00", "#21468B"],
  belgium: ["#ED2939", "#FAE042"],
  nigeria: ["#008751", "#FFFFFF"],
  brazil: ["#FFDF00", "#009C3B"],
  argentina: ["#75AADB", "#FFFFFF"],
  colombia: ["#FCD116", "#003893"],
  usa: ["#0A3161", "#B31942"],
  mexico: ["#006847", "#CE1126"],
};

function hashColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 45%)`;
}

function lookup(name: string): [string, string] {
  const n = name.toLowerCase();
  const key = Object.keys(KNOWN)
    .sort((a, b) => b.length - a.length)
    .find((k) => n.includes(k));
  return key ? KNOWN[key] : [hashColor(name), "#FFFFFF"];
}

function rgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function distance(a: string, b: string): number {
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return 999;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** Readable text colour on top of a team colour. */
export function inkOn(hex: string): string {
  const c = rgb(hex);
  if (!c) return "#fff";
  const lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  return lum > 0.6 ? "#0b0b0c" : "#ffffff";
}

export function teamColors(teamA: string, teamB: string): [string, string] {
  const a = lookup(teamA);
  const b = lookup(teamB);
  let cb = b[0];
  if (distance(a[0], cb) < 120) cb = distance(a[0], b[1]) >= 120 ? b[1] : "#f2efe8";
  return [a[0], cb];
}
