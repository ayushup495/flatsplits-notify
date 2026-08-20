// api/notify.js
// This folder is its own Vercel project (separate from the FlatSplits GitHub Pages site).
// Deployed, this file becomes: https://flatsplits-notify.vercel.app/api/notify

const admin = require('firebase-admin');

const DEBUG_VERSION = 'v4-debug';

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

  const body = req.body || {};
  const { houseId, addedByUsername, addedByName, description, amount } = body;

  // Trim both sides — the same kind of stray-whitespace issue we already hit once on GitHub
  // could just as easily be sitting in the secret value.
  const receivedSecret = String(req.headers['x-notify-secret'] || '').trim();
  const expectedSecret = String(process.env.NOTIFY_SECRET || '').trim();
  const secretOk = receivedSecret === expectedSecret;

  // Writes a breadcrumb for EVERY POST that reaches this function, pass or fail,
  // so nothing can happen invisibly. Check houses/{houseId}/lastNotifyDebug after any test.
  async function writeDebug(extra) {
    if (!houseId) return;
    try {
      const fbAdmin = getAdmin();
      await fbAdmin.database().ref(`/houses/${houseId}/lastNotifyDebug`).set(Object.assign({
        version: DEBUG_VERSION,
        time: new Date().toISOString(),
        gotAddedByUsername: addedByUsername || null,
        secretOk: secretOk,
        receivedSecretLength: receivedSecret.length,
        expectedSecretLength: expectedSecret.length
      }, extra));
    } catch (e) { /* never let a debug-write failure break the real notify */ }
  }

  if (!secretOk) {
    await writeDebug({ stoppedAt: 'secret check' });
    return res.status(401).json({ error: 'unauthorized', version: DEBUG_VERSION });
  }

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
    if (String(m.username || '').toLowerCase().trim() === String(addedByUsername || '').toLowerCase().trim()) return;
    targets.push({ idx, token: m.fcmToken, username: m.username });
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
        const badIdx = targets[i].idx;
        clears.push(db.ref(`/houses/${houseId}/members/${badIdx}/fcmToken`).remove());
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
};
