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
  let ref = null, unsub = null, timer = null;
  const hhmm = () => new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
  async function push(st) {
    if (!ref) return;
    try { await S.setDoc(ref, {data: JSON.stringify(st), updatedAt: st.updatedAt || Date.now()}); status("Cloud tersinkron " + hhmm()); }
    catch (e) { status("Cloud gagal menyimpan: " + (e.code || e.message) + " (data tetap aman di perangkat ini)"); }
  }
  window.SM_hooks = {
    onSave(st) { clearTimeout(timer); timer = setTimeout(() => push(st), 700); },
    onLogout() { clearTimeout(timer); if (unsub) unsub(); unsub = null; ref = null; F.signOut(auth); }
  };
  F.onAuthStateChanged(auth, user => {
    if (!user) return;
    window.SM.cloudEnter({id: "g_" + user.uid, name: user.displayName || user.email, email: user.email});
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
