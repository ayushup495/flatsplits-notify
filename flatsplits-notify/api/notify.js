// api/notify.js
// This folder is its own Vercel project (separate from the FlatSplits GitHub Pages site).
// Deployed, this file becomes: https://flatsplits-notify.vercel.app/api/notify

const admin = require('firebase-admin');

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
    return res.status(405).json({ error: 'POST only' });
  }

  if (req.headers['x-notify-secret'] !== process.env.NOTIFY_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { houseId, addedByUsername, addedByName, description, amount } = req.body || {};
  if (!houseId || !addedByUsername) {
    return res.status(400).json({ error: 'houseId and addedByUsername are required' });
  }

  const fbAdmin = getAdmin();
  const db = fbAdmin.database();

  // Matches the FlatSplits schema: houses/{houseId}/members is an array,
  // each member optionally has a .fcmToken (written by setupFCM() on login).
  const snap = await db.ref(`/houses/${houseId}/members`).once('value');
  const members = snap.val() || [];

  const targets = [];
  members.forEach((m, idx) => {
    if (!m || !m.fcmToken) return;
    if (m.username === addedByUsername) return; // don't notify whoever just added it
    targets.push({ idx, token: m.fcmToken });
  });

  if (targets.length === 0) {
    return res.status(200).json({ sent: 0, note: 'no flatmate tokens registered yet' });
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

  // A dead/expired token means that member needs to log in again to get a fresh one —
  // clear it so we stop trying to send to it.
  const deadCodes = ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'];
  const clears = [];
  response.responses.forEach((r, i) => {
    if (!r.success && deadCodes.includes(r.error && r.error.code)) {
      const badIdx = targets[i].idx;
      clears.push(db.ref(`/houses/${houseId}/members/${badIdx}/fcmToken`).remove());
    }
  });
  await Promise.all(clears);

  return res.status(200).json({ sent: response.successCount, failed: response.failureCount });
};
