// Phone verification through verify.mn — proof that a number exists and that
// the member saving it is holding the phone.
//
// It works backwards from the usual code-by-SMS: we make up a code, and the
// member texts it to the 144773 shortcode *from* the number they typed. Only
// that phone can do it, so a made-up number never gets saved. verify.mn tells
// us when the text arrives; we ask every few seconds rather than expose a
// callback URL, since the bot has no web server.
//
// Off unless VERIFY_MN_API_KEY is set. Mongolian numbers only — the shortcode
// can't be reached from anywhere else.
//
// Saved in data/store.json under guild.contacts.phoneVerified = { discordId: number }.
// A number counts as verified only while it matches the one saved. Waits in
// progress are kept under guild.contacts.phonePending so a restart can resume them.
// A number an admin vouched for instead (/sgphone verify) also records who, under
// guild.contacts.phoneVerifiedBy = { discordId: adminId }.

import { randomInt } from 'node:crypto';
import { MessageFlags, InteractionWebhook } from 'discord.js';
import { config } from './config.js';
import * as store from './store.js';

const POLL_MS = 3000; // verify.mn asks for no faster than this
const SESSION_MS = 5 * 60 * 1000; // how long their sessions live
const REQUEST_TIMEOUT_MS = 10_000;

/** One wait per member: asking again abandons the earlier code. */
const pending = new Map();

export const phoneVerifyOn = () => Boolean(config.verifyApiKey);

/** Whether the number someone has saved is one they proved they hold. */
export function isPhoneVerified(guildId, userId) {
  const saved = store.getContacts(guildId, 'phone')[userId];
  return Boolean(saved) && store.getContacts(guildId, 'phoneVerified')[userId] === saved;
}

/** Whether that verification came from an admin rather than an SMS. */
export const phoneVerifiedByAdmin = (guildId, userId) =>
  isPhoneVerified(guildId, userId) ? store.getContacts(guildId, 'phoneVerifiedBy')[userId] || null : null;

/**
 * An admin vouches for someone's number — for when the SMS can't get through
 * (no credit, a work phone, the shortcode blocked) but they know it's real.
 * Saves the number as verified and drops any code the member was waiting on.
 */
export function forceVerifyPhone(guildId, userId, number, adminId) {
  const waiting = pending.get(`${guildId}:${userId}`);
  if (waiting) {
    waiting.cancelled = true;
    waiting.reason = '✅ An admin has verified your number, so there is no need to send the SMS.';
  }
  store.removeContact(guildId, 'phonePending', userId);
  store.setContact(guildId, 'phone', userId, number);
  store.setContact(guildId, 'phoneVerified', userId, number);
  store.setContact(guildId, 'phoneVerifiedBy', userId, adminId);
}

/** "+97699112233" -> "99112233", or null for a number from another country. */
function localPart(number) {
  const prefix = `+${config.phoneCountry.replace(/\D/g, '')}`;
  const local = number.startsWith(prefix) ? number.slice(prefix.length) : '';
  return local.length === config.phoneLocalDigits ? local : null;
}

async function api(path, options = {}) {
  const res = await fetch(`${config.verifyApiBase}${path}`, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`verify.mn ${options.method || 'GET'} ${path.split('/')[1]} → HTTP ${res.status}`);
  return res.json();
}

const createSession = (phone, text) =>
  api('/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.verifyApiKey}` },
    body: JSON.stringify({ phone, text }),
  });

const sessionStatus = async (sessionId) =>
  (await api(`/sessions/${encodeURIComponent(sessionId)}`)).sessionStatus;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Forget a wait, unless a newer one has already taken its place. */
function clearPending(guildId, userId, sessionId) {
  if (store.getContacts(guildId, 'phonePending')[userId]?.sessionId === sessionId) {
    store.removeContact(guildId, 'phonePending', userId);
  }
}

/**
 * Ask verify.mn about one session until the text arrives or time runs out, then
 * save the number or say why not. Always asks at least once, so a text that
 * arrived while the bot was down is still found.
 */
async function awaitText({ guildId, userId, job, sessionId, number, expires, edit, show = (n) => n, onSaved }) {
  const deadline = Math.min(expires, Date.now() + SESSION_MS) + POLL_MS;
  let status = await sessionStatus(sessionId).catch(() => 'PENDING');
  while (status === 'PENDING' && Date.now() < deadline) {
    await sleep(POLL_MS);
    if (job.cancelled) return edit(job.reason || '↩️ You asked for a new code, so this one was dropped.');
    // One failed check is not a failed verification: keep asking until the deadline.
    status = await sessionStatus(sessionId).catch(() => 'PENDING');
  }
  if (job.cancelled) return undefined;
  clearPending(guildId, userId, sessionId);

  if (status !== 'VERIFIED') {
    return edit(
      `⌛ No text arrived from ${show(number)} in time, so it wasn't saved. ` +
        `Check the number and run \`/${config.phoneRoot} set\` again for a new code.`,
    );
  }
  store.setContact(guildId, 'phone', userId, number);
  store.setContact(guildId, 'phoneVerified', userId, number);
  store.removeContact(guildId, 'phoneVerifiedBy', userId); // proven by SMS now, not on anyone's word
  await edit(`✅ Verified and saved your phone number: ${show(number)}`);
  await onSaved?.();
  return undefined;
}

/**
 * On startup: pick up every wait that was cut short by a restart. The member's
 * private reply can still be edited through its interaction token for a while;
 * past that the number is simply saved without a word.
 */
export function resumePhoneVerifications(client) {
  if (!phoneVerifyOn()) return;
  for (const guildId of Object.keys(store.allGuilds())) {
    for (const [userId, wait] of Object.entries(store.getContacts(guildId, 'phonePending'))) {
      const key = `${guildId}:${userId}`;
      const job = { cancelled: false };
      pending.set(key, job);
      const hook = wait.token ? new InteractionWebhook(client, client.application.id, wait.token) : null;
      const edit = async (content) => {
        await hook?.editMessage('@original', { content, allowedMentions: { parse: [] } }).catch(() => {});
      };
      awaitText({ guildId, userId, job, ...wait, edit, show: (n) => `\`${n}\`` })
        .catch((err) => console.error('Resumed phone verification failed:', err.message))
        .finally(() => {
          if (pending.get(key) === job) pending.delete(key);
        });
    }
  }
}

/**
 * Take a parsed number through verification and save it once the member's text
 * arrives. Answers the interaction itself, privately. `show` renders a number
 * for display; `onSaved` runs after a successful save.
 */
export async function verifyAndSavePhone(interaction, number, { show = (n) => n, onSaved } = {}) {
  const { guildId } = interaction;
  const userId = interaction.user.id;
  const say = (content) =>
    interaction.reply({ flags: MessageFlags.Ephemeral, content, allowedMentions: { parse: [] } });

  const local = localPart(number);
  if (!local) {
    return say(
      `❌ Numbers are verified by SMS, and that only works for ${config.phoneCountry} numbers — ` +
        `${config.phoneLocalDigits} digits like \`9911 2233\`.`,
    );
  }
  if (store.getContacts(guildId, 'phone')[userId] === number && isPhoneVerified(guildId, userId)) {
    return say(`📱 ${show(number)} is already saved and verified.`);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const edit = (content) => interaction.editReply({ content, allowedMentions: { parse: [] } }).catch(() => {});

  const key = `${guildId}:${userId}`;
  const earlier = pending.get(key);
  if (earlier) earlier.cancelled = true;
  const job = { cancelled: false };
  pending.set(key, job);

  try {
    const code = String(randomInt(100000, 1000000));
    let session;
    try {
      session = await createSession(local, code);
    } catch (err) {
      console.error('Phone verification could not start:', err.message);
      return edit('❌ The verification service isn’t answering right now, so nothing was saved. Try again in a minute.');
    }

    const expires = Date.parse(session.expiresAt) || Date.now() + SESSION_MS;
    const shortcode = session.shortcode || '144773';
    // Written down before the member is told to send anything: they are about
    // to pay for an SMS, and a restart must not make the bot forget to look for it.
    store.setContact(guildId, 'phonePending', userId, {
      sessionId: session.sessionId,
      number,
      expires,
      token: interaction.token,
    });
    await edit(
      `📱 One step left — prove ${show(number)} is yours.\n\n` +
        `From **that phone**, text \`${session.text || code}\` to **${shortcode}**.\n` +
        (session.displayInstruction ? `> ${session.displayInstruction}\n` : '') +
        `\nIt's an ordinary paid SMS (about 150₮), and the code runs out <t:${Math.floor(expires / 1000)}:R>. ` +
        `This message updates by itself once the text arrives — nothing is saved until then.`,
    );
    return await awaitText({ guildId, userId, job, sessionId: session.sessionId, number, expires, edit, show, onSaved });
  } finally {
    if (pending.get(key) === job) pending.delete(key);
  }
}
