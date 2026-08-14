// Shared Firebase Admin init for serverless functions.
// Set env var FIREBASE_SERVICE_ACCOUNT to the full JSON of a service account key
// (Firebase Console > Project settings > Service accounts > Generate new private key),
// pasted as a single-line string.
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

module.exports = admin;
