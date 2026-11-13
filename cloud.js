// cloud.js — sinkronisasi Smart Money lewat Firebase (Login Google + Firestore).
// Aktif hanya jika firebase-config.js sudah diisi dan enabled: true, dan web dibuka lewat http(s)/localhost.
(async function () {
  const cfg = window.FIREBASE_CONFIG, $ = s => document.querySelector(s);
  const status = t => window.SM && window.SM.setStatus(t);
  const placeholder = !cfg || !cfg.enabled || !cfg.apiKey || /^ISI_/.test(cfg.apiKey) || /^ISI_/.test(cfg.projectId || "");
  if (placeholder) { status("Cloud nonaktif (firebase-config.js belum diisi / enabled: false)"); return; }
  if (location.protocol === "file:") { status("Cloud tidak bisa dari file://; buka lewat https:// atau localhost"); return; }
  const base = "https://www.gstatic.com/firebasejs/10.12.2/";
  let A, F, S;
  try { [A, F, S] = await Promise.all([import(base + "firebase-app.js"), import(base + "firebase-auth.js"), import(base + "firebase-firestore.js")]); }
  catch (e) { status("Cloud gagal dimuat (cek koneksi internet)"); return; }
  const app = A.initializeApp(cfg), auth = F.getAuth(app), db = S.getFirestore(app);
  const btn = $("#googleButton"); btn.classList.remove("hidden");
  btn.addEventListener("click", async () => {
    try { await F.signInWithPopup(auth, new F.GoogleAuthProvider()); }
    catch (e) { const el = $("#authError"); el.textContent = "Login Google gagal: " + (e.code || e.message); el.classList.remove("hidden"); }
  });
  const note = $("#authNote");
  if (note) note.textContent = "Daftar atau masuk dengan email yang sama di perangkat mana pun (cukup sekali per perangkat). Setelah itu kamu tetap masuk dan datamu tersinkron otomatis sampai kamu memilih keluar.";
  const errMsg = c => ({"auth/email-already-in-use": "Email sudah terdaftar. Silakan masuk.", "auth/invalid-credential": "Email atau kata sandi salah.", "auth/wrong-password": "Email atau kata sandi salah.", "auth/user-not-found": "Email atau kata sandi salah.", "auth/weak-password": "Kata sandi terlalu lemah (minimal 8 karakter).", "auth/invalid-email": "Email tidak valid.", "auth/too-many-requests": "Terlalu banyak percobaan. Coba lagi nanti.", "auth/network-request-failed": "Tidak ada koneksi internet.", "auth/operation-not-allowed": "Metode Email/Password belum diaktifkan di Firebase Console."})[c] || ("Gagal: " + c);
  let pendingName = "", ref = null, unsub = null, timer = null;
  const hhmm = () => new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
  async function push(st) {
    if (!ref) return;
    try { await S.setDoc(ref, {data: JSON.stringify(st), updatedAt: st.updatedAt || Date.now()}); status("Cloud tersinkron " + hhmm()); }
    catch (e) { status("Cloud gagal menyimpan: " + (e.code || e.message) + " (data tetap aman di perangkat ini)"); }
  }
  window.SM_hooks = {
    async authSubmit(mode, {name, email, pw}) {
      try {
        if (mode === "register") { pendingName = name; const cred = await F.createUserWithEmailAndPassword(auth, email, pw); try { await F.updateProfile(cred.user, {displayName: name}); } catch (e) {} }
        else await F.signInWithEmailAndPassword(auth, email, pw);
        return null;
      } catch (e) { return errMsg(e.code || e.message); }
    },
    onSave(st) { clearTimeout(timer); timer = setTimeout(() => push(st), 700); },
    onLogout() { clearTimeout(timer); if (unsub) unsub(); unsub = null; ref = null; F.signOut(auth); }
  };
  F.onAuthStateChanged(auth, user => {
    if (!user) { const u = window.SM.getUser(); if (u && u.id.startsWith("g_")) status("Sesi cloud berakhir. Masuk lagi untuk melanjutkan sinkronisasi (data tetap aman di perangkat ini)"); return; }
    window.SM.cloudEnter({id: "g_" + user.uid, name: user.displayName || pendingName || user.email, email: user.email});
    ref = S.doc(db, "users", user.uid); if (unsub) unsub();
    unsub = S.onSnapshot(ref, snap => {
      const st = window.SM.getState();
      if (!snap.exists()) { push(st); return; }
      const d = snap.data(), remote = d.updatedAt || 0, local = st.updatedAt || 0;
      if (remote > local) { try { window.SM.applyRemote(JSON.parse(d.data)); status("Cloud: data terbaru diterima " + hhmm()); } catch (e) { status("Data cloud tidak valid"); } }
      else if (remote < local) push(st);
      else status("Cloud tersinkron " + hhmm());
    }, e => status("Cloud gagal: " + (e.code || e.message)));
  });
})();
