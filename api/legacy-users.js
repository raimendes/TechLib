import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

function getAdminApp() {
  if (getApps().length) return getApps()[0];

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !rawPrivateKey) {
    throw new Error(
      "Variáveis FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY não configuradas no Vercel."
    );
  }

  return initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey: rawPrivateKey.replace(/\\n/g, "\n")
    }),
    projectId
  });
}

function send(res, status, body) {
  res.status(status).json(body);
}

function bearer(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function correctedStudentEmail(email) {
  const normalized = normalizeEmail(email);
  return normalized.endsWith("@estudante.gov.rn.br")
    ? normalized.replace("@estudante.gov.rn.br", "@estudante.rn.gov.br")
    : normalized;
}

async function requireAdmin(adminAuth, adminDb, req) {
  const token = bearer(req);
  if (!token) {
    const error = new Error("Token de autenticação não enviado.");
    error.status = 401;
    throw error;
  }

  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(token);
  } catch {
    const error = new Error("Sessão inválida ou expirada.");
    error.status = 401;
    throw error;
  }

  if (decoded.email_verified !== true) {
    const error = new Error("A conta administrativa precisa ter o e-mail confirmado.");
    error.status = 403;
    throw error;
  }

  const snap = await adminDb.doc(`users/${decoded.uid}`).get();
  if (!snap.exists) {
    const error = new Error("Perfil administrativo não encontrado.");
    error.status = 403;
    throw error;
  }

  const profile = snap.data() || {};
  const role = String(profile.role || profile.baseRole || "").trim();

  if (profile.isActive === false || role !== "Administrador") {
    const error = new Error("Somente Administrador pode executar a limpeza de perfis antigos.");
    error.status = 403;
    throw error;
  }

  return { uid: decoded.uid, role };
}

async function scanLegacyUsers(adminAuth, adminDb) {
  const usersSnap = await adminDb.collection("users").get();
  const candidates = [];
  const unresolved = [];

  for (const doc of usersSnap.docs) {
    const data = doc.data() || {};
    const email = normalizeEmail(data.email);

    if (!email.endsWith("@estudante.gov.rn.br")) continue;

    const correctedEmail = correctedStudentEmail(email);

    let authUser = null;
    try {
      authUser = await adminAuth.getUserByEmail(correctedEmail);
    } catch (error) {
      if (error?.code !== "auth/user-not-found") throw error;
    }

    if (!authUser) {
      unresolved.push({
        legacyUid: doc.id,
        name: String(data.name || "").trim(),
        legacyEmail: email,
        correctedEmail,
        reason: "Nenhuma conta atual encontrada no Firebase Authentication."
      });
      continue;
    }

    if (authUser.uid === doc.id) {
      unresolved.push({
        legacyUid: doc.id,
        name: String(data.name || "").trim(),
        legacyEmail: email,
        correctedEmail,
        reason: "O documento usa o mesmo UID da conta atual; não será removido automaticamente."
      });
      continue;
    }

    const currentRef = adminDb.doc(`users/${authUser.uid}`);
    const currentSnap = await currentRef.get();

    candidates.push({
      legacyUid: doc.id,
      currentUid: authUser.uid,
      name: String(data.name || authUser.displayName || "").trim(),
      legacyEmail: email,
      correctedEmail,
      currentProfileExists: currentSnap.exists,
      legacyOperatorEnabled: data.operatorEnabled === true
    });
  }

  return { candidates, unresolved };
}

async function migrateBasicProfileIfNeeded(adminDb, item, legacyData) {
  const currentRef = adminDb.doc(`users/${item.currentUid}`);
  const currentSnap = await currentRef.get();

  if (currentSnap.exists) {
    const current = currentSnap.data() || {};
    const patch = {
      email: item.correctedEmail,
      updatedAt: FieldValue.serverTimestamp()
    };

    if (!String(current.name || "").trim() && String(legacyData.name || "").trim()) {
      patch.name = String(legacyData.name).trim();
    }

    await currentRef.set(patch, { merge: true });
    return false;
  }

  await currentRef.set({
    name: String(legacyData.name || "").trim(),
    email: item.correctedEmail,
    baseRole: "Aluno",
    role: "Aluno",
    isActive: legacyData.isActive !== false,
    operatorEnabled: false,
    migratedFromLegacyUid: item.legacyUid,
    createdFromLegacyCleanup: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: false });

  return true;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET" && !req.headers.authorization) {
    try {
      getAdminApp();
      return send(res, 200, {
        ok: true,
        service: "TechLib Legacy Users Cleanup API",
        configured: true,
        version: "legacy-student-domain-v1"
      });
    } catch (error) {
      return send(res, 500, { ok: false, configured: false, error: error.message });
    }
  }

  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { ok: false, error: "Método não permitido." });
  }

  try {
    const app = getAdminApp();
    const adminAuth = getAuth(app);
    const adminDb = getFirestore(app);

    const admin = await requireAdmin(adminAuth, adminDb, req);
    const scan = await scanLegacyUsers(adminAuth, adminDb);

    if (req.method === "GET") {
      return send(res, 200, {
        ok: true,
        mode: "preview",
        candidates: scan.candidates,
        unresolved: scan.unresolved
      });
    }

    const action = String(req.body?.action || "").trim();
    const legacyUids = Array.isArray(req.body?.legacyUids)
      ? req.body.legacyUids.map((v) => String(v || "").trim()).filter(Boolean)
      : [];

    if (action !== "delete-selected") {
      return send(res, 400, { ok: false, error: "Ação inválida." });
    }

    if (!legacyUids.length) {
      return send(res, 400, { ok: false, error: "Nenhum perfil antigo foi selecionado." });
    }

    const byUid = new Map(scan.candidates.map((item) => [item.legacyUid, item]));
    const deleted = [];
    const skipped = [];

    for (const legacyUid of legacyUids) {
      const item = byUid.get(legacyUid);

      if (!item) {
        skipped.push({ legacyUid, reason: "Não está na lista segura de candidatos." });
        continue;
      }

      const legacyRef = adminDb.doc(`users/${legacyUid}`);
      const legacySnap = await legacyRef.get();

      if (!legacySnap.exists) {
        skipped.push({ legacyUid, reason: "Documento antigo já não existe." });
        continue;
      }

      const legacyData = legacySnap.data() || {};
      const createdCurrentProfile = await migrateBasicProfileIfNeeded(
        adminDb,
        item,
        legacyData
      );

      await legacyRef.delete();

      deleted.push({
        legacyUid,
        currentUid: item.currentUid,
        correctedEmail: item.correctedEmail,
        createdCurrentProfile
      });
    }

    return send(res, 200, {
      ok: true,
      deleted,
      skipped,
      executedBy: admin.uid
    });
  } catch (error) {
    console.error("TechLib legacy-users API:", error);
    const status = Number(error.status) || 500;
    return send(res, status, {
      ok: false,
      error:
        status === 500
          ? "Não foi possível concluir a limpeza. Verifique os logs da API no Vercel."
          : error.message
    });
  }
}
