// Convert whatever a user pastes into the STEAM_1:Y:Z format the CS2KZ API expects.

const BASE = 76561197960265728n; // SteamID64 of account id 0

function steam64ToSteam2(id64) {
  const account = id64 - BASE;
  if (account < 0n) return null;
  const y = account % 2n;
  const z = account / 2n;
  return `STEAM_1:${y}:${z}`;
}

/**
 * Accepts:
 *   - SteamID64            76561198282622073
 *   - SteamID2 (any univ.) STEAM_0:1:161178172 / STEAM_1:1:161178172
 *   - SteamID3             [U:1:322356345] or U:1:322356345
 *   - Profile URL          https://steamcommunity.com/profiles/76561198282622073
 * Returns a normalized "STEAM_1:Y:Z" string, or null if it can't be parsed.
 * (Custom vanity URLs like /id/name need a Steam Web API key to resolve, so they aren't supported.)
 */
export function parseSteamId(input) {
  if (input == null) return null;
  const s = String(input).trim();

  // A SteamID2 anywhere in the text (e.g. inside a cs2kz.org/profile/STEAM_1:1:… link).
  const steam2 = s.match(/STEAM_[0-5]:([01]):(\d+)/i);
  if (steam2) return `STEAM_1:${steam2[1]}:${steam2[2]}`;

  // A SteamID3, e.g. [U:1:12345] or U:1:12345.
  const steam3 = s.match(/\[?U:1:(\d+)\]?/i);
  if (steam3) return steam64ToSteam2(BASE + BigInt(steam3[1]));

  // A 17-digit SteamID64 anywhere (raw, or in a steamcommunity.com/profiles/ link).
  const steam64 = s.match(/\b(\d{17})\b/);
  if (steam64) return steam64ToSteam2(BigInt(steam64[1]));

  return null;
}

/** STEAM_1:Y:Z -> SteamID64 string, for building steamcommunity.com profile links. */
export function steamIdTo64(steam2) {
  const m = String(steam2).match(/^STEAM_[0-5]:([01]):(\d+)$/i);
  if (!m) return null;
  return (BASE + BigInt(m[2]) * 2n + BigInt(m[1])).toString();
}
