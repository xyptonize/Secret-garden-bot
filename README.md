# SG-BOT

The Secret Garden Discord bot. Each feature has its own `sg***` command root:

| Root | Feature |
|---|---|
| `/sgkz` | CS2KZ records, rankings, rank roles, maps & bounties |
| `/sghb` | Birthday reminders |
| `/sgdraft` | CS2 team drafter — balanced teams by AURA, plus a bracket |
| `/sgig` `/sgphone` `/sgsteam` | Saved contacts — Instagram, phone (admins only), Steam |
| `/sgprofile` | One card per member: stats, socials, KZ and draft record |
| `/sgcase` | Profile-card backgrounds, unboxed like CS2 skins |
| `/sgcasino` | Wager seeds — fair-odds games, duels and draft-match betting |
| `/sgcount` | Counting draw — count up together, three members win |

## CS2KZ (`/sgkz`)

Members link their SteamID, then:

- 🏁 **Announces new CS2KZ records** in a channel of your choice, automatically.
- 🏆 **Shows a leaderboard** of *only your registered members*, ranked by CKZ or VNL rating.
- 📌 Keeps an **auto-updating pinned leaderboard** message current.
- 🎖️ **Assigns CKZ rank roles** (Noob → God) to members based on their rating.
- 🎉 **Announces rank-ups** when a member climbs into a higher tier.
- 👤 Looks up any registered member's CS2KZ profile.

Data comes from the official [CS2KZ API](https://docs.cs2kz.org/api/).

---

## 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**. Name it.
2. On **General Information**, copy the **Application ID** → this is your `CLIENT_ID`.
3. Open the **Bot** tab → **Reset Token** → copy it → this is your `DISCORD_TOKEN`. Keep it secret.
4. Still on the **Bot** tab, you do **not** need any Privileged Gateway Intents (this bot uses slash commands).
5. Open **OAuth2 → URL Generator**:
   - Scopes: check **`bot`** and **`applications.commands`**.
   - Bot Permissions: **Send Messages**, **Embed Links**, **Read Message History**, **Manage Messages** (to pin the leaderboard), **Manage Roles** (to create & assign rank roles).
   - Copy the generated URL, open it, and invite the bot to your server.

> **Rank roles:** after inviting, go to **Server Settings → Roles** and drag the **bot's own role above** the `CKZ …` rank roles. Discord only lets a bot manage roles below its highest role. If you don't want rank roles at all, set `ENABLE_RANK_ROLES=false` in `.env`.

## 2. Get your IDs

In Discord, enable **Settings → Advanced → Developer Mode**. Then:

- Right-click your **server icon → Copy Server ID** → `GUILD_ID`.
- Right-click the **channel** you want announcements in → **Copy Channel ID** → `ANNOUNCE_CHANNEL_ID` (optional; you can also set it later with `/sgkz setchannel`).

## 3. Configure

```powershell
# In the project folder:
copy .env.example .env
```

Open `.env` and fill in `DISCORD_TOKEN`, `CLIENT_ID`, and (recommended) `GUILD_ID`.

## 4. Install & run

```powershell
npm install
npm run deploy    # registers the slash commands (run again whenever commands change)
npm start         # starts the bot
```

If `GUILD_ID` is set, commands appear instantly. Without it they register globally and can take up to an hour.

---

## Commands

Every command lives under one parent command, `/sgkz` by default (set `COMMAND_ROOT` in `.env`), so it can't clash with other bots.

| Command | Who | What it does |
|---|---|---|
| `/sgkz register <steamid>` | anyone | Link your Steam account. Accepts SteamID64 (`7656…`), `STEAM_1:0:…`, `[U:1:…]`, or a `steamcommunity.com/profiles/…` link. |
| `/sgkz unregister [user]` | anyone / admins | Stop tracking you and remove you from the leaderboard (your CKZ rank role is removed too). Admins can remove someone else, e.g. a member who left. |
| `/sgkz rankings [mode]` | anyone | Leaderboard of registered members by CKZ (default) or VNL rating. |
| `/sgkz profile [user] [mode]` | anyone | Member's CS2KZ stats, latest run, and a PRO/TP completion table by tier. |
| `/sgkz ranks` | anyone | The CKZ rank ladder and your current rank. |
| `/sgkz unfinished <tier> [type] [mode] [user]` | anyone | Courses of a tier (or all) not yet completed. |
| `/sgkz finished <tier> [type] [mode] [user]` | anyone | Courses of a tier already completed, with times. |
| `/sgkz maplists [tier] [type] [mode]` | anyone | Every approved CS2KZ map, grouped by tier. |
| `/sgkz maptop <map> [course] [type] [mode]` | anyone | This server's ranking on one course, with each run's global rank. Map and course names **autocomplete** as you type. |
| `/sgkz bounty list` | anyone | Active and recently claimed bounties. |
| `/sgkz bounty add <map> <reward> [course] [mode] [type] [note]` | admins | The first registered member to finish the map *after the bounty is posted* wins; if two finish between checks, whoever finished first. No course means the **Main** course. |
| `/sgkz bounty remove <id>` | admins | Cancel a bounty. |
| `/sgkz leaderboard setup [channel]` | admins | Post & pin the live leaderboard and create rank roles. |
| `/sgkz leaderboard refresh` | admins | Update the pinned leaderboard and rank roles immediately. |
| `/sgkz setchannel [channel]` | admins | Choose where record, rank-up and bounty announcements are posted. |
| `/sgkz help` | anyone | Command overview (generated from the registered commands). |

"Admins" means members with the **Manage Server** permission.

> Custom vanity URLs (`steamcommunity.com/id/name`) can't be resolved without a Steam Web API key — open your profile and copy the numeric `/profiles/7656…` link instead.

## Unfinished maps

`/sgkz unfinished` shows which maps of a given tier a member still needs to complete. Tiers are:

`1 Very Easy · 2 Easy · 3 Medium · 4 Advanced · 5 Hard · 6 Very Hard · 7 Extreme · 8 Death · 9 Unfeasible · 10 Impossible`

So "tier 4" is **Advanced**. Example: `/sgkz unfinished tier:Tier 4 · Advanced mode:ckz` lists every Advanced CKZ course you haven't finished, grouped by map.

**PRO vs TP** — the `type` option (default **Both**) shows two separate sections:

- 🟢 **PRO** — finished with **0 teleports**. Matched against each course's `pro_tier`.
- 🔵 **TP** — finished with teleports allowed (any completion counts). Matched against each course's `nub_tier`.

Because a course can have a different PRO tier and TP tier, the two lists are genuinely different. Pick `type: PRO` or `type: TP` to see just one.

> Discord slash commands use named options rather than free text, so `/cs2kz ckz tier4` becomes **`/sgkz unfinished`** with `tier` = *Tier 4 · Advanced* and `mode` = *Classic (CKZ)* picked from dropdowns.

## Live leaderboard & CKZ rank roles

Run **`/sgkz leaderboard setup`** (admins) in the channel you want the standings in. The bot:

1. Posts a leaderboard embed of your registered members (by CKZ rating) and **pins it**.
2. Creates one Discord role per rank tier (`CKZ Noob`, `CKZ Intermediate`, …).
3. Every `LEADERBOARD_INTERVAL_SECONDS` (default 15 min) it re-fetches everyone's rating, edits the pinned message in place, and updates each member's rank role (adds the one they qualify for, removes the others).

Use `/sgkz leaderboard refresh` to update instantly, and `/sgkz ranks` to see the ladder and your current rank.

### Editing the rank ladder

The ladder lives in **`src/ranks.js`** — one array, easy to change:

```js
export const RANKS = [
  { name: 'Noob',         minRating: 0,     color: 0x95a5a6 },
  { name: 'Intermediate', minRating: 5000,  color: 0x2ecc71 },
  { name: 'Elite',        minRating: 10000, color: 0x3498db },
  { name: 'Master',       minRating: 15000, color: 0x9b59b6 },
  { name: 'Pro',          minRating: 20000, color: 0xf1c40f },
  { name: 'Legend',       minRating: 25000, color: 0xe74c3c },
  { name: 'God',          minRating: 30000, color: 0xe91e63 },
];
```

Each member gets the highest rank whose `minRating` ≤ their `ckz_rating`. Keep the list ordered ascending. `ckz_rating` is the CS2KZ "Player Points" total. After editing names, the bot creates the new roles on the next refresh — delete any now-unused old `CKZ …` roles manually.

### Rank-up announcements

When a member crosses into a higher rank, the bot posts a 🎉 celebration to the **announcement channel** (the one from `/sgkz setchannel` / `ANNOUNCE_CHANNEL_ID`). It primes silently on first run, so it never announces everyone's current rank, and it stays quiet on rank *drops* (which can happen if ratings are recalculated). Set `ENABLE_RANKUP_ANNOUNCEMENTS=false` to turn it off.

> CS2KZ only officially documents Noob / Intermediate / Pro tiers; the higher tiers here are a starting point you can tune freely.

## How announcements work

The bot polls the CS2KZ API every `POLL_INTERVAL_SECONDS` (default 120). When you `/sgkz register`, it records your **existing** runs so it won't spam your history — only runs you set *after* registering are announced. Set `ANNOUNCE_MIN_POINTS` in `.env` if you only want noteworthy runs announced.

## Configuration reference (`.env`)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | — | Bot token. |
| `CLIENT_ID` | ✅ | — | Application ID. |
| `GUILD_ID` | recommended | — | Your server ID (instant command registration). |
| `ANNOUNCE_CHANNEL_ID` | — | — | Default announcement channel (or use `/sgkz setchannel`). |
| `POLL_INTERVAL_SECONDS` | — | `120` | How often to check for new records (min 30). |
| `ANNOUNCE_MIN_POINTS` | — | `0` | Only announce runs worth at least this many points. |
| `DEFAULT_MODE` | — | `ckz` | Default mode for rankings, profiles and map commands (`ckz` or `vnl`). |
| `LEADERBOARD_INTERVAL_SECONDS` | — | `900` | How often to refresh the pinned leaderboard and rank roles (min 60). |
| `ENABLE_RANK_ROLES` | — | `true` | Set `false` to skip creating/assigning rank roles. |
| `ENABLE_RANKUP_ANNOUNCEMENTS` | — | `true` | Set `false` to skip 🎉 rank-up announcements. |
| `RANK_ROLE_PREFIX` | — | `CKZ` | Prefix for auto-created rank roles (`CKZ Noob`, …). |
| `LEADERBOARD_TITLE` | — | `CS2KZ Leaderboard — CKZ` | Title of the pinned leaderboard embed. |
| `COMMAND_ROOT` | — | `sgkz` | Parent command name (`/sgkz register`, …). Re-run `npm run deploy` after changing it. |
| `BIRTHDAY_COMMAND_ROOT` | — | `sghb` | Parent command for birthday commands. |
| `BIRTHDAY_CHANNEL_ID` | — | — | Default birthday channel (or use `/sghb setchannel`). |
| `BIRTHDAY_HOUR` | — | `9` | Hour (0–23) the birthday message is posted. |
| `BIRTHDAY_TIMEZONE` | — | server timezone | IANA timezone for the hour above, e.g. `Asia/Ulaanbaatar`. |
| `DRAFT_GIRL_ROLE` | — | `HOT GIRLS🎀` | Role (name or id) marking girl players for the drafter. |
| `DRAFT_AURA_GOD` / `DRAFT_AURA_KING` | — | `0` / `0.5` | AURA values of the GOD and KING roles. |
| `DRAFT_DEFAULT_AURA` | — | `5.5` | AURA for players with no AURA role. |
| `DRAFT_STICKY_SECONDS` | — | `5` | Keep open lobbies at the bottom of their channel: re-post after this many quiet seconds (0 = off). |
| `DRAFT_RESHUFFLE_TOLERANCE` | — | `1` | How far from the best split a Reshuffle may go. |
| `PHONE_ROLES` | — | — | Roles (names or ids, comma separated) allowed to see and list phone numbers. The server owner always can. Unset = anyone with Manage Server. |
| `CASE_COMMAND_ROOT` | — | `sgcase` | Parent command for the card/case commands. |
| `CASE_DAILY_SEEDS` | — | `25` | Seeds paid with the free daily case. |
| `CASE_STREAK_SEEDS` | — | `5` | Extra seeds per consecutive daily claim… |
| `CASE_STREAK_MAX` | — | `100` | …capped here. |
| `CASE_PRICE` | — | `400` | Seeds per case in `/sgcase buy`. |
| `CASE_DROP_CHANCE` | — | `0.2` | Chance of a case per announced KZ record (0–1). |
| `CASE_DROP_DAILY_CAP` | — | `3` | Most play-drops one member can get in a day. |
| `CASE_CHAMPION_CASES` | — | `1` | Cases for each player on a winning draft team. |
| `CASE_REVEAL_MS` | — | `900` | Pause between unboxing animation frames. |
| `CASE_ADMIN_ID` | — | — | Discord user ID of the **only** member who may `/sgcase give`. Unset = anyone with Manage Server. |
| `CASE_TIMEZONE` | — | `BIRTHDAY_TIMEZONE` | Timezone deciding when "today" rolls over for daily claims. |
| `CASINO_COMMAND_ROOT` | — | `sgcasino` | Parent command for the casino. |
| `CASINO_MIN_BET` / `CASINO_MAX_BET` | — | `10` / `5000` | Smallest and largest stake, in seeds. |
| `CASINO_DAILY_LOSS_CAP` | — | `20000` | Once a member has lost this much in a day the bot stops taking their bets (0 = no cap). |
| `CASINO_DUEL_MINUTES` | — | `5` | How long a duel challenge stands before it expires. |
| `CASINO_SPIN_MS` | — | `800` | Pause before the slots result. |
| `COUNT_COMMAND_ROOT` | — | `sgcount` | Parent command for the counting draw. |
| `COUNT_DAILY_LIMIT` | — | `5` | Numbers one member may claim per day. |
| `COUNT_WEIGHTED` | — | `true` | Every number held is a ticket. `false` = one entry per member. |
| `COUNT_NO_DOUBLE` | — | `false` | `true` stops anyone taking two numbers in a row. |
| `COUNT_STRIKES` | — | `3` | Wrong numbers before a member can no longer win the round (0 = off). |
| `COUNT_CHAT_STRIKES` | — | `true` | Writing anything that isn't a number costs a strike too. |
| `COUNT_NUMBERS_ONLY` | — | `true` | Deletes anything that isn't a number in the counting channel (needs Manage Messages). |
| `COUNT_DELETE_WRONG` | — | `false` | `true` also deletes wrong numbers instead of just marking them ❌. |
| `COUNT_LOCK_CHANNEL` | — | `true` | Open the counting channel when a round starts and close it when the round ends (needs Manage Roles). |
| `COUNT_REVEAL_MS` | — | `2500` | Pause between revealing 3rd, 2nd and 1st. |
| `CS2KZ_API_BASE` | — | `https://api.cs2kz.org` | API base URL. |

## Birthday reminders (`/sghb`)

| Command | Who | What it does |
|---|---|---|
| `/sghb set <day> <month> [year]` | anyone | Save your birthday. The year is optional and only used to show the age; leaving it empty keeps the year you saved before (use `remove` then `set` to clear it). |
| `/sghb remove [user]` | anyone / admins | Remove your birthday (admins can remove anyone's). |
| `/sghb list` | anyone | Upcoming birthdays, soonest first. |
| `/sghb add <user> <day> <month> [year]` | admins | Save someone else's birthday. |
| `/sghb setchannel [channel]` | admins | Choose the birthday channel (separate from the `/sgkz` announcement channel). |

Every day at `BIRTHDAY_HOUR` (default 09:00) in `BIRTHDAY_TIMEZONE` (default: the server's timezone) the bot posts one 🎂 message in the birthday channel, pinging everyone whose birthday it is. If the bot was offline at that hour, it posts once when it comes back that day, and never twice. People born on 29 February are celebrated on 28 February in non-leap years. Members who have left the server are skipped.

## CS2 team drafter (`/sgdraft`)

| Command | Who | What it does |
|---|---|---|
| `/sgdraft start [title] [join]` | anyone | Open a lobby in this channel. The number of teams is decided at Draft, once everyone has joined. |
| `/sgdraft add <user>` / `/sgdraft kick <user>` | host | Add or remove a player in this channel's lobby. |
| `/sgdraft swap <player1> <player2>` | host | Swap two drafted players (between teams, or with someone sitting out). |
| `/sgdraft friends <a> <b> [c] [d] [e]` | 👑 host | Keep those players on the same team in every draft and reshuffle. Merges with a group they're already in. |
| `/sgdraft unfriends <user>` | 👑 host | Let a player be drafted anywhere again. |
| `/sgdraft aura [user]` | anyone | Show a player's AURA (and 🎀) as the drafter reads it. |
| `/sgdraft mock count:<n>` / `clear:True` | host | Add fake players (🧪 Mock 01, …) to test the whole flow in Discord, or remove them. A lobby with mock players is a **test lobby**: its brackets are never saved to history. |
| `/sgdraft sub <out> <in>` | host | Replace a player who can't continue, even mid-tournament (same as the 🔁 Sub button). |
| `/sgdraft host <user>` | host, or an admin | Hand the lobby to a new host. An admin can take over only a lobby whose host has **left the server or been inactive for an hour**, and the handover is announced in the channel. |
| `/sgdraft close` | host | Close this channel's lobby (same as the Close button). This also works if the lobby message was deleted. |
| `/sgdraft history [user] [page]` | anyone | Past tournaments, newest first (optionally only ones a player was in). |
| `/sgdraft game <id>` | anyone | One tournament in full: every team and its players, every result, byes, who sat out. |
| `/sgdraft stats [user]` | anyone | A player's tournaments, titles, match W–L, most frequent teammates, recent results. |
| `/sgdraft top` | anyone | Leaderboard: most titles, then most match wins. |

**1. Lobby.** Players click **Join** and get a private confirmation ("✅ You joined … as player #3 · AURA 3.5"). Pressing Join again tells them they're already in and which number they are. Each player is listed by name with their AURA and 🎀, read from their roles. A player with no AURA role counts as `DRAFT_DEFAULT_AURA` (5.5) and is marked ❔.

**2. Teams.** Nobody knows in advance how many will show up, so the team count isn't set up front. When the host presses **Draft**, the bot privately asks **"How many teams?"** and lists only what the turnout allows. For example, 17 players gives *2 teams (10 play · 7 sit out)* or *3 teams (15 play · 2 sit out)*. With 10–14 players 2 teams is the only option, so it drafts right away. The last to join sit out, and the host can Swap anyone in. After the draft, a menu on the lobby lets the host change the number of teams (it redrafts). Draft balances every team against every other by total AURA, so the *spread* (highest − lowest total) is as small as possible. AURA is the raw role number: `AURA - GOD` = `DRAFT_AURA_GOD` (0), `AURA - KING` = `DRAFT_AURA_KING` (0.5), and roles are re-read at every draft. Up to 24 teams.
- **Top tiers are split up.** With N teams, the N strongest players each lead a different team. With 4 teams and GOD, KING, 1, 1.5 on top, each of them is on another team. A tie at the cutoff (two 1.5s for the last spot) is broken at random. Among equally balanced lineups the bot also picks the least stacked one, so a spare strong player goes to a team led by a weaker top player, never to GOD's.
- **Girls** (`DRAFT_GIRL_ROLE`, default `HOT GIRLS🎀`) are spread evenly, so team girl counts differ by at most one and as many teams as possible get one. With fewer girls than teams, the rest are balanced on AURA alone.
- **🔀 Reshuffle** shows another lineup within `DRAFT_RESHUFFLE_TOLERANCE` (1) of the best spread.
- **✏️ Swap** lets the host trade any two players. Totals update right away and the teams are marked *edited by host*.

**3. Bracket.** The host presses **🏁 Start bracket** and picks how the first round is paired. It's single elimination with one winner.
- *🥇 Seeded:* strongest meets weakest and the top seeds take the byes, so the best teams meet late (a normal tournament draw).
- *⚖️ Closest AURA:* the teams with the closest totals face each other; the weakest teams get the byes.
- *🎲 Random:* random pairings and random byes.
- *Pick matchups:* the bot asks the host privately for two teams at a time — "choose two teams for match 1 of 2" — until every match is set. Teams left unpaired get the byes, and the host is told how many that will be. **Cancel** drops it; nothing starts until the last pair is chosen. The bracket then shows *matchups picked by the host*.
- The host clicks **Team X won** for each match, and winners advance automatically. When the final is decided, the bot posts 🏆 and pings the winning team.
- **↩️ Undo result** reverts the last result. **Cancel bracket** returns to the teams, unlocked. Teams and the roster are locked while a bracket runs.

**🔒 Lock.** The host can lock the lobby (button next to Notify): Join and Leave grey out, nobody can come or go, and the footer shows 🔒. **Unlock** reopens it. The host can still add, kick, swap and sub while locked.

**A late Join never destroys the teams.** Even unlocked, someone joining after the draft is added to the players **sitting out** — the teams stay exactly as they were, and the host can Reshuffle them in or bring them on with Sub. The teams are only cleared when someone *on a team* leaves or is kicked, since then a team really is a player short (whoever did it is told).

**📣 Notify.** The host can call players in at any time with **📣 Notify**. **Before the draft**, everyone who has joined is pinged and DM'd that the lobby *is about to start*. **After the draft** (the button sits next to Start bracket, or first in the row during a bracket), everyone on a team is **@pinged in the channel** and gets a **DM with a link to the lobby's channel** (the lobby is always the newest message there). Players sitting out and mock players aren't notified. The host is told how many were pinged and DM'd, and how many have DMs closed. There's a 1-minute cooldown so a double-click can't ping everyone twice; press it again after changes to re-notify.

**Substitutes.** If a player can't continue, even in the middle of a bracket, the host presses **🔁 Sub** (or runs `/sgdraft sub`). The bot asks privately *who can't continue?* and then *who replaces them?*: someone sitting out, or **anyone in the server**, even if they never joined. The newcomer takes the same spot on the same team, the leaver moves to *sits out*, and the channel gets a 🔁 message pinging the newcomer. Substitution is the only roster change allowed while a bracket runs.

**4. History (kept forever).** Every bracket is recorded as a numbered tournament (`#1`, `#2`, …) in `data/draft-history.json` as soon as it starts, and the record is updated after every result or Undo.
- **What's saved:** the title, host, pairing mode, start and end time, each team with its players (name, AURA and 🎀 *as they were at the time*), who sat out, byes, every match (round, which team beat which, **and the exact lineups that played it**), every substitution (who left, who came in, after which match) and the champion. `/sgdraft stats` credits each win or loss to whoever actually played that match, and a title to whoever played the final.
- **Unfinished brackets:** one cancelled or closed before any result is dropped. One stopped after some matches is kept and marked *cancelled*, because those games were played.
- **Nothing is ever deleted automatically.** Back up `data/draft-history.json` together with `data/store.json`.

**Stays at the bottom.** An open lobby never gets buried by chat. When people talk in its channel, the bot re-posts the lobby below the new messages and deletes the old copy. It waits until the chat has been quiet for `DRAFT_STICKY_SECONDS` (default 5), but never more than 4× that during non-stop chat. Set it to `0` to turn this off. Clicking a button on an old copy just says the lobby moved.

**Deleting the lobby message doesn't close it.** If a moderator or a purge bot deletes it, the bot re-posts it. Only the host closes a lobby; deleting the whole channel or thread also ends it.

**Only the host runs the lobby.** Every lobby control (Draft, Reshuffle, Swap, team count, bracket, winners, Undo, Cancel, Close and the host commands) works for the host only, even for members with Manage Server. **Close asks for confirmation.** If the host disappears, an admin passes the lobby on with `/sgdraft host`.

When a champion is decided the bot posts a **recap** that stays in the channel: champions, runner-up, the path through every round, how it was paired, how long it took, and the tournament number to look it up later.

Lobbies are saved to `data/store.json`, so they survive bot restarts. A lobby stays open until the host (or an admin) clicks **Close** or runs `/sgdraft close`, or until its message is deleted. The bot notices deletions, which is why it uses the non-privileged *Guild Messages* intent; no Developer Portal change is needed.

## Contacts — Instagram (`/sgig`), phone (`/sgphone`), Steam (`/sgsteam`)

Members save their own; `/sgig` is public, `/sgphone` is private.

| Command | Who | What it does |
|---|---|---|
| `/sgig set <value>` | anyone | Save your Instagram handle. Accepts `name`, `@name` or an instagram.com link. |
| `/sgig view [user]` | anyone | Show someone's handle as a clickable link (public reply). |
| `/sgig list` | anyone | Everyone's handles. |
| `/sgig remove [user]` | anyone / admins | Remove yours; admins can remove anyone's. |
| `/sgphone set <value>` | anyone | Save your number. Accepts 8 digits (`9911 2233` → `+976 9911 2233`), `+976…`, `00976…` or any international `+…` number. |
| `/sgphone view [user]` | you / `PHONE_ROLES` | **Private reply.** Only you can see your own; only the allowed roles can look up someone else's. |
| `/sgphone list` | `PHONE_ROLES` | **Private reply.** Everyone's numbers. Anyone else gets "🔒 Phone numbers are private — only @OWNER👻, @Discord Developer, @Developer can list them". |
| `/sgphone remove [user]` | anyone / admins | Remove yours; admins can remove anyone's. |
| `/sgsteam set <value>` | anyone | Save your Steam profile. Accepts a `steamcommunity.com/id/…` or `/profiles/…` link, a SteamID64, `STEAM_1:0:…` or `[U:1:…]`. |
| `/sgsteam view [user]` / `list` / `remove [user]` | anyone | Same as `/sgig`, public. |

**Who can see a number** is set by `PHONE_ROLES` in `.env` — role names or ids, comma separated — plus the server owner, who always can. It is currently **OWNER👻, Discord Developer, Developer**. This is deliberately narrower than "admins": Manage Server is held by six member roles here and a dozen bot integrations, which is far more people than should see a phone list. Leaving `PHONE_ROLES` unset falls back to anyone with Manage Server.

Every `/sgphone` reply is ephemeral, so a number is never posted into a channel. Numbers and handles live in `data/store.json` (mode 600, owner tengis.g) and are included in the daily backup. Set `PHONE_COUNTRY_CODE` / `PHONE_LOCAL_DIGITS` in `.env` for another country (defaults `+976` and 8).

## `/sgprofile` — one card per member

`/sgprofile [user]` puts everything the bot knows in one public embed. On **your own** card, buttons fill in what's missing: **Use my KZ Steam** copies the SteamID you already registered in one click, and the rest open a small form (the birthday form accepts `14/03`, `14 March 1999`, …).

- **💬 Discord** — when they joined the server, when the account was created, whether they're boosting, and their top roles.
- **🔗 Saved** — birthday (with age when the year is known), Instagram, Steam. A saved phone number only ever shows as *private*, never the number.
- **🏁 CS2KZ** — their SteamID and Steam link, live CKZ/VNL ratings and rank, and their **global standing** among all CS2KZ players (e.g. `#216 of 127,747`), when they're registered with `/sgkz register`.
- **🎮 Draft** — their AURA (read from their roles) and their tournament record: played, titles, W–L.

- **🎒 Cards** — how much of the background collection they've unlocked, and what they're holding.

Sections with nothing to show are left out, and a member who has left the server still shows what they saved. The embed also carries a **rendered card image** — their avatar and stats over whichever background they have equipped (see below).

## Profile-card backgrounds (`/sgcase`)

Every `/sgprofile` card is drawn on a background, and backgrounds are unlocked from **Garden Cases** on CS2's own odds:

| Rarity | Chance | Designs | A duplicate pays |
|---|---|---|---|
| 🔵 Mil-Spec | 79.92% | 7 | 🌱 20 |
| 🟣 Restricted | 15.98% | 6 | 🌱 60 |
| 🩷 Classified | 3.20% | 4 | 🌱 200 |
| 🔴 Covert | 0.64% | 3 | 🌱 700 |
| 🟡 Exceedingly Rare | 0.26% | 2 | 🌱 2,500 |

All 22 designs are drawn by the bot itself (`src/cardArt.js`) — there are no image files to host, and the same id always draws the same picture. Rolls use a cryptographic random source.

**Where cases come from — all four:**

- 📅 `/sgcase daily` — one free case a day, plus 🌱 seeds (more for a longer streak).
- 🏁 **Playing KZ** — a 20% chance of a case on each announced record, at most 3 a day. The drop is appended to the announcement.
- 🏆 **Winning a draft** — every player on the champion team gets one (never from a 🧪 test lobby).
- 🌱 `/sgcase buy` — 400 seeds each. Seeds come from duplicates and daily claims.

| Command | Who | What it does |
|---|---|---|
| `/sgcase daily` | anyone | Claim today's free case and seeds. |
| `/sgcase open` | anyone | Open a case, with a reveal. A Covert or better pull is announced to the channel. |
| `/sgcase inventory [user]` | anyone | Cases, seeds, streak and a picture of the whole collection — with an equip menu on your own. |
| `/sgcase preview <background>` | anyone | Look at any background (owned ones are suggested first). |
| `/sgcase buy [cases]` | anyone | Buy cases with seeds. |
| `/sgcase odds` | anyone | The drop table and where cases come from. |
| `/sgcase give <user> [cases] [seeds]` | `CASE_ADMIN_ID` only | Hand out (or take back) cases and seeds. With no `CASE_ADMIN_ID` set, anyone with Manage Server can. |

A new background is equipped automatically when it's rarer than what you're wearing; otherwise pick one from `/sgcase inventory`. The case is spent and the result saved **before** the reveal is animated, so a Discord hiccup can never cost someone a pull.

## Casino (`/sgcasino`)

Seeds earned from `/sgcase` can be wagered. **The house takes nothing** — every payout is the exact inverse of its chance, so a bet returns exactly its stake on average and seeds only move between members. This is verified by test, not just by intent: 400,000 simulated bets per game land within noise of break-even.

| Game | How it pays |
|---|---|
| 🪙 `flip` | Call heads or tails — 50% to double. **2×** |
| 🎲 `dice` | Roll 1–100, call over or under a line. **100 ÷ winning numbers** (over 60 → 2.50×) |
| 🎰 `slots` | 7 symbols on 3 reels. Pair **2×** (36.7%), any triple **11×** (1.7%), 🟡🟡🟡 **25×** (0.29%) — expected return exactly 1.00 |
| 💣 `mines` | 20 tiles, 1–10 bombs. Each safe tile raises the multiplier; cash out whenever. Clearing the board with one bomb pays **20×** |
| 🃏 `blackjack` | Dealer draws to 17, blackjack pays 3:2. The only game with an inherent edge (~0.5%) — the rules give it, not the bot |
| ⚔️ `duel <user>` | Challenge a member; both stake, one flip, winner takes the pot |
| 🏆 `bet` | Back a team in a running `/sgdraft` match |

**Match betting is pari-mutuel:** every seed staked on a match goes into one pot, and when the host marks the winner the pot is split among whoever backed that team, in proportion to their stake. The bot keeps nothing, and the rounding remainder goes to the largest backer so not one seed is created or destroyed. Stakes are refunded in full if the bracket is cancelled, the teams are redrawn, or the lobby is closed. **Nobody playing in a match may bet on it — either way**, so no one can be paid to lose.

Limits: stakes run from `CASINO_MIN_BET` to `CASINO_MAX_BET`, and once a member has lost `CASINO_DAILY_LOSS_CAP` in a day the bot stops taking their bets until tomorrow. `/sgcasino stats` shows a member's record; `/sgcasino odds` shows every payout and the chance behind it.

Games that span several presses (mines, blackjack) keep their state in `data/store.json`, and any game still running when the bot restarts has its stake **refunded** on startup rather than swallowed.

## Counting draw (`/sgcount`)

An admin opens a round over a range — say **1 to 500**. The bot announces it with **@everyone**, names the range, and posts the rules; members then count up **in order** in that channel. Type the next number and it's yours (✅); type a different number and it doesn't count (❌). **Anything that isn't a number is deleted** — the channel stays a clean run of numbers — and the member is told once (at most once a minute) what the next number is. The bot needs **Manage Messages** there; `/sgcount open` refuses up front if it doesn't have it, rather than letting chat pile up. Each member may claim **5 numbers a day** (`COUNT_DAILY_LIMIT`).

**Three strikes**, and every strike says what it was for:

| What happened | The member is told |
|---|---|
| Someone claimed the number first (lag, or just slower) | *"**6** was already taken — someone got there first"* |
| Counted out of turn | *"wrote **99** when the next number was **7**"* |
| Wrote something that isn't a number | *"wrote something that wasn't a number"* |

Each costs one strike, with a note that takes itself back after a few seconds. On the third, a message that **stays** says they're **out of the round**: anything else they post in the channel is removed with a "you can't count any more" reply, and the numbers they already hold can no longer win. Strikes last for the round and reset when the next one opens; `/sgcount forgive` lets someone back in.

Because being struck out stops a member counting, a round can run out of people to fill it. When everyone who has counted is struck out the bot says so in the channel, naming the number it's stuck on, so an admin can `forgive` someone or `close` the round rather than leaving it stuck. New members joining can always count.

**An unlucky draw burns its prize.** The bot draws exactly three times. If one of them is a struck-out member, that place is announced as lost — **💀 UNLUCKY — @them held 237 but struck out 3 times · 50,000₮ goes unclaimed** — and it is *not* passed to anyone else. That round simply has two winners.

Strikes are per round and show in `/sgcount status`, `me`, `top` and `/sgcount strikes` (which lists each member's reasons). `/sgcount forgive <user>` clears them — with real money at stake, a strike from a dropped connection shouldn't be final.

When the last number is claimed the bot draws **three different members** and reveals them in suspense order: 🥉 third, then 🥈 second, then 🥇 first — the biggest prize last. Every number you hold is a ticket, so counting more often is worth more (`COUNT_WEIGHTED=false` for one entry per member regardless).

| Command | Who | What it does |
|---|---|---|
| `/sgcount open <from> <to> [channel] [title] [ping] [prize1..3]` | Manage Server | Start a round: announces **@everyone — counting is open, X to Y** and posts the rules. `ping` can be `@here` or `Nobody` instead. |
| `/sgcount status` | anyone | The next number, how far along, how many you hold. |
| `/sgcount me` | anyone | Every number you hold. |
| `/sgcount top` | anyone | Who holds the most tickets, and their share of the draw. |
| `/sgcount strikes` | anyone | Who has strikes, and who can no longer win. |
| `/sgcount forgive <user>` | Manage Server | Clear a member's strikes. |
| `/sgcount close` | Manage Server | Draw now, without filling the range. |
| `/sgcount cancel` | Manage Server | Drop the round with no draw. |
| `/sgcount history` · `/sgcount round <id>` | anyone | Past rounds and who won what. |

**The channel is only open while a round is running.** Opening a round lets `@everyone` send messages there; drawing, closing or cancelling it takes that away again and the bot says `🔒 The counting channel is closed until the next round opens.` The bot grants itself an explicit allow before locking, so it can still announce the next round. This needs **Manage Roles** in that channel; without it the round still opens and `/sgcount open` says what's missing. `COUNT_LOCK_CHANNEL=false` leaves the channel alone.

**Give the count a channel of its own.** `/sgcount open` looks at the last 25 messages and warns if another bot is posting there: a second counting bot will delete numbers this one has already counted, and the two cannot be reconciled afterwards. It also warns if `@everyone` can't type there.

**The first guess is free.** Until the first number is claimed, a wrong number costs no strike — it just says where the round starts. Typing `1` at a round that opens on `0` is an honest mistake, not a disqualification.

Prizes are free text (`100,000₮`), so the bot announces and records them but never handles money. The full ledger of **who held which number** is kept forever in `data/count-history.json` alongside the winners, so any draw can be audited afterwards. Winners are drawn with a cryptographic random source, and the result is written to that file **before** it is announced.

> **Requires the Message Content privilege.** Reading typed numbers needs it, and it is a switch only the application owner can flip: <https://discord.com/developers/applications> → the app → **Bot** → **Privileged Gateway Intents** → **Message Content Intent**. The bot checks for the privilege at startup and only asks the gateway for it when it has been granted — so it keeps running normally without it, logging a warning, and `/sgcount` starts working the moment the switch is on and the bot is restarted.

## Backups and service

- **Daily backup:** `sgkz-bot-backup.timer` runs `deploy/backup-data.sh` at 04:30 and saves `data/` (registrations, bounties, birthdays, lobbies, draft history, card collections, counting rounds) as `/home/tengis.g/bot-backups/data-YYYY-MM-DD.tar.gz`. It keeps 30 days, readable only by tengis.g. Run one now with `systemctl start sgkz-bot-backup`.
- **Restoring:** `systemctl stop sgkz-bot`, then `tar -xzf /home/tengis.g/bot-backups/data-<date>.tar.gz -C /home/tengis.g/bot/data`, then `systemctl start sgkz-bot`.
- **Service user:** the bot runs as **tengis.g**, not root (`/etc/systemd/system/sgkz-bot.service.d/override.conf`, a copy is in `deploy/`), with `NoNewPrivileges`, `PrivateTmp` and `ProtectSystem=full`. `data/` must stay owned by tengis.g.

## Where data is stored

Registrations, seen-record state, bounties, rank-role IDs, birthdays, saved contacts, card collections, casino wallets and the open counting round live in `data/store.json`; draft tournament history lives in `data/draft-history.json`, and finished counting rounds in `data/count-history.json`. Both are created automatically and git-ignored; back up the whole `data/` folder to keep registrations and history.

## Notes

- Runs with **0 teleports** are shown as **PRO**; others show the teleport count.
- "CKZ" = Classic mode, "VNL" = Vanilla mode — matching the API's `ckz_rating` / `vnl_rating`.
- The bot only needs one process running. Host it anywhere that keeps Node alive (your PC, a VPS, etc.).
