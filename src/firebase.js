'use strict';

const admin = require('firebase-admin');

let app;
let db;

function normalizePrivateKey(value) {
  return String(value || '')
    .replace(/^"|"$/g, '')
    .replace(/\\n/g, '\n');
}

function assertFirebaseConfig(firebaseConfig) {
  const missing = [];
  if (!firebaseConfig.projectId) missing.push('FIREBASE_PROJECT_ID');
  if (!firebaseConfig.clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
  if (!firebaseConfig.privateKey) missing.push('FIREBASE_PRIVATE_KEY');

  if (missing.length > 0) {
    throw new Error(`Missing Firebase environment variables: ${missing.join(', ')}`);
  }
}

function initializeFirebase(firebaseConfig) {
  if (db) return db;
  assertFirebaseConfig(firebaseConfig);

  app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: firebaseConfig.projectId,
      clientEmail: firebaseConfig.clientEmail,
      privateKey: normalizePrivateKey(firebaseConfig.privateKey)
    })
  });

  db = admin.firestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

function getDb() {
  if (!db) {
    throw new Error('Firebase has not been initialized');
  }
  return db;
}

module.exports = {
  FieldValue: admin.firestore.FieldValue,
  Timestamp: admin.firestore.Timestamp,
  getDb,
  initializeFirebase
};
