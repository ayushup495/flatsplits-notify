// api/notify.js
// This folder is its own Vercel project (separate from the FlatSplits GitHub Pages site).
// Deployed, this file becomes: https://flatsplits-notify.vercel.app/api/notify

const admin = require('firebase-admin');

const DEBUG_VERSION = 'v7-cors-fix';

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
  return admin;
}

// Firebase can return houses/{id}/members as either a real JS array or a
// plain object, depending on the exact key shape — this normalizes either
// into a list of [key, memberObject] pairs so nothing downstream ever
// depends on which shape it happened to be this time.
function membersToEntries(membersRaw) {
  if (Array.isArray(membersRaw)) {
    return membersRaw.map(function (m, idx) { return [String(idx), m]; });
  }
  return Object.entries(membersRaw || {});
}

module.exports = async (req, res) => {
  // CORS — your app runs on github.io, this function runs on vercel.app.
  // Different origins, so the browser sends a silent "preflight" OPTIONS
  // request first to ask permission, and blocks the real POST entirely if
  // it doesn't get these headers back. This was very likely missing before.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-notify-secret');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const startTime = new Date().toISOString();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only', version: DEBUG_VERSION });
  }

  // Everything below is wrapped — every outcome, including a total crash,
  // writes something to /debug/lastNotify. Nothing can happen invisibly.
  try {
    const body = req.body || {};
    const { houseId, addedByUsername, addedByName, description, amount } = body;

    const receivedSecret = String(req.headers['x-notify-secret'] || '').trim();
    const expectedSecret = String(process.env.NOTIFY_SECRET || '').trim();
    const secretOk = receivedSecret === expectedSecret;

    const fbAdmin = getAdmin();
    const db = fbAdmin.database();

    async function writeDebug(extra) {
      try {
        await db.ref('/debug/lastNotify').set(Object.assign({
          version: DEBUG_VERSION,
          time: startTime,
          houseId: houseId || null,
          gotAddedByUsername: addedByUsername || null,
          rawBodyKeys: Object.keys(body),
          secretOk: secretOk,
          receivedSecretLength: receivedSecret.length,
          expectedSecretLength: expectedSecret.length
        }, extra));
      } catch (e) { /* swallow — debug must never break the real send */ }
    }

    if (!secretOk) {
      await writeDebug({ stoppedAt: 'secret check' });
      return res.status(401).json({ error: 'unauthorized', version: DEBUG_VERSION });
    }

    if (!houseId || !addedByUsername) {
      await writeDebug({ stoppedAt: 'missing fields' });
      return res.status(400).json({ error: 'houseId and addedByUsername are required', version: DEBUG_VERSION });
    }

    const snap = await db.ref(`/houses/${houseId}/members`).once('value');
    const memberEntries = membersToEntries(snap.val());
    const allUsernames = memberEntries.map(function (e) { return e[1] && e[1].username; }).filter(Boolean);

    const targets = [];
    memberEntries.forEach(function (entry) {
      const key = entry[0], m = entry[1];
      if (!m || !m.fcmToken) return;
      if (String(m.username || '').toLowerCase().trim() === String(addedByUsername || '').toLowerCase().trim()) return;
      targets.push({ key: key, token: m.fcmToken, username: m.username });
    });

    if (targets.length === 0) {
      await writeDebug({ stoppedAt: 'no targets', sent: 0, allMemberUsernames: allUsernames, targetedUsernames: [] });
      return res.status(200).json({ sent: 0, note: 'no flatmate tokens registered yet', gotAddedByUsername: addedByUsername, version: DEBUG_VERSION });
    }

    const title = 'New expense added';
    const bodyText = amount
      ? `${addedByName || addedByUsername} added ₹${amount}${description ? ' for ' + description : ''}. Tap to see how much you owe.`
      : `${addedByName || addedByUsername} added a new expense. Tap to see how much you owe.`;

    const response = await fbAdmin.messaging().sendEachForMulticast({
      tokens: targets.map(t => t.token),
      notification: { title, body: bodyText },
      webpush: { fcmOptions: { link: 'https://ayushup495.github.io/FlatSplits/' } }
    });

    const deadCodes = ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'];
    const clears = [];
    const errorDetails = [];
    response.responses.forEach((r, i) => {
      if (!r.success) {
        errorDetails.push({ username: targets[i].username, code: (r.error && r.error.code) || 'unknown' });
        if (deadCodes.includes(r.error && r.error.code)) {
          clears.push(db.ref(`/houses/${houseId}/members/${targets[i].key}/fcmToken`).remove());
        }
      }
    });
    await Promise.all(clears);

    await writeDebug({
      stoppedAt: 'completed',
      sent: response.successCount,
      failed: response.failureCount,
      allMemberUsernames: allUsernames,
      targetedUsernames: targets.map(t => t.username),
      errors: errorDetails
    });

    return res.status(200).json({ sent: response.successCount, failed: response.failureCount, targeted: targets.map(t => t.username), version: DEBUG_VERSION });

  } catch (err) {
    try {
      const fbAdmin = getAdmin();
      await fbAdmin.database().ref('/debug/lastNotify').set({
        version: DEBUG_VERSION,
        time: startTime,
        stoppedAt: 'CRASH',
        errorMessage: err && err.message,
        errorStack: err && err.stack ? String(err.stack).slice(0, 500) : null
      });
    } catch (e2) { /* truly nothing more we can do */ }
    return res.status(500).json({ error: 'internal error', message: err && err.message, version: DEBUG_VERSION });
  }
};
