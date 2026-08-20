// api/notify.js
// This folder is its own Vercel project (separate from the FlatSplits GitHub Pages site).
// Deployed, this file becomes: https://flatsplits-notify.vercel.app/api/notify

const admin = require('firebase-admin');

const DEBUG_VERSION = 'v3-debug';

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only', version: DEBUG_VERSION });
  }

  if (req.headers['x-notify-secret'] !== process.env.NOTIFY_SECRET) {
    return res.status(401).json({ error: 'unauthorized', version: DEBUG_VERSION });
  }

  const { houseId, addedByUsername, addedByName, description, amount } = req.body || {};
  if (!houseId || !addedByUsername) {
    return res.status(400).json({ error: 'houseId and addedByUsername are required', version: DEBUG_VERSION });
  }

  const fbAdmin = getAdmin();
  const db = fbAdmin.database();

  // Matches the FlatSplits schema: houses/{houseId}/members is an array,
  // each member optionally has a .fcmToken (written by setupFCM() on login).
  const snap = await db.ref(`/houses/${houseId}/members`).once('value');
  const members = snap.val() || [];
  const allUsernames = members.map(function (m) { return m && m.username; }).filter(Boolean);

  const targets = [];
  members.forEach((m, idx) => {
    if (!m || !m.fcmToken) return;
    // trim + lowercase both sides — guards against stray whitespace or case differences
    if (String(m.username || '').toLowerCase().trim() === String(addedByUsername || '').toLowerCase().trim()) return;
    targets.push({ idx, token: m.fcmToken, username: m.username });
  });

  // Writes a full snapshot of what happened to houses/{houseId}/lastNotifyDebug —
  // check that in the Firebase console any time, no need to catch a toast in the moment.
  async function writeDebug(extra) {
    try {
      await db.ref(`/houses/${houseId}/lastNotifyDebug`).set(Object.assign({
        version: DEBUG_VERSION,
        time: new Date().toISOString(),
        gotAddedByUsername: addedByUsername,
        allMemberUsernames: allUsernames,
        targetedUsernames: targets.map(t => t.username)
      }, extra));
    } catch (e) { /* never let a debug-write failure break the real notify */ }
  }

  if (targets.length === 0) {
    await writeDebug({ sent: 0, note: 'no flatmate tokens registered yet' });
    return res.status(200).json({ sent: 0, note: 'no flatmate tokens registered yet', gotAddedByUsername: addedByUsername, version: DEBUG_VERSION });
  }

  const title = 'New expense added';
  const body = amount
    ? `${addedByName || addedByUsername} added ₹${amount}${description ? ' for ' + description : ''}. Tap to see how much you owe.`
    : `${addedByName || addedByUsername} added a new expense. Tap to see how much you owe.`;

  const response = await fbAdmin.messaging().sendEachForMulticast({
    tokens: targets.map(t => t.token),
    notification: { title, body },
    webpush: { fcmOptions: { link: 'https://ayushup495.github.io/FlatSplits/' } }
  });

  const deadCodes = ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'];
  const clears = [];
  const errorDetails = [];
  response.responses.forEach((r, i) => {
    if (!r.success) {
      errorDetails.push({ username: targets[i].username, code: (r.error && r.error.code) || 'unknown' });
      if (deadCodes.includes(r.error && r.error.code)) {
        const badIdx = targets[i].idx;
        clears.push(db.ref(`/houses/${houseId}/members/${badIdx}/fcmToken`).remove());
      }
    }
  });
  await Promise.all(clears);

  await writeDebug({ sent: response.successCount, failed: response.failureCount, errors: errorDetails });

  return res.status(200).json({ sent: response.successCount, failed: response.failureCount, targeted: targets.map(t => t.username), version: DEBUG_VERSION });
};
