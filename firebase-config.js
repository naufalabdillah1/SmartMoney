// firebase-config.js — konfigurasi Firebase untuk Smart Money.
// Isi dari: Firebase Console > Project settings (ikon roda gigi) > General > Your apps > Web app > "SDK setup and configuration" > Config.
// Catatan: apiKey Firebase untuk web BUKAN rahasia (memang tampil di browser). Keamanan data diatur oleh firestore.rules dan "Authorized domains".
// Setelah semua diisi, ubah enabled menjadi true.
window.FIREBASE_CONFIG = {
  enabled: false,
  apiKey: "ISI_API_KEY",
  authDomain: "ISI_PROJECT_ID.firebaseapp.com",
  projectId: "ISI_PROJECT_ID",
  storageBucket: "ISI_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "ISI_SENDER_ID",
  appId: "ISI_APP_ID"
};
