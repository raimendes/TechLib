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

  const privateKey = rawPrivateKey.replace(/\\n/g, "\n");

  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    projectId
  });
}

function send(res, status, body) {
  res.status(status).json(body);
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return "";
  return header.slice(7).trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeProfile(uid, authUser, data = {}) {
  const baseRole = data.baseRole === "Professor" ? "Professor" : "Aluno";
  const allowedRoles = ["Aluno", "Professor", "Bibliotecário", "Administrador"];
  const role = allowedRoles.includes(data.role) ? data.role : baseRole;

  return {
    uid,
    name: String(data.name || authUser.displayName || "").trim(),
    email: normalizeEmail(data.email || authUser.email),
    baseRole,
    role,
    isActive: data.isActive !== false,
    operatorEnabled: data.operatorEnabled === true
  };
}

async function findLegacyProfileByEmail(adminDb, email, currentUid) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return { snapshot: null, ambiguous: false };
  }

  // Os perfis do TechLib armazenam o e-mail normalizado em minúsculas.
  // Buscamos até 3 resultados apenas para detectar duplicidade e evitar
  // migrar automaticamente um perfil ambíguo.
  const querySnapshot = await adminDb
    .collection("users")
    .where("email", "==", normalizedEmail)
    .limit(3)
    .get();

  const candidates = querySnapshot.docs.filter((doc) => doc.id !== currentUid);

  if (candidates.length === 0) {
    return { snapshot: null, ambiguous: false };
  }

  if (candidates.length > 1) {
    return { snapshot: null, ambiguous: true };
  }

  return { snapshot: candidates[0], ambiguous: false };
}

async function ensureCurrentUidProfile(adminDb, authUser) {
  const currentUid = authUser.uid;
  const currentRef = adminDb.doc(`users/${currentUid}`);
  const currentSnapshot = await currentRef.get();

  if (currentSnapshot.exists) {
    return {
      snapshot: currentSnapshot,
      migrated: false,
      migratedFromUid: null
    };
  }

  const email = normalizeEmail(authUser.email);

  if (!email) {
    const error = new Error(
      "A conta autenticada não possui e-mail. Não foi possível localizar um perfil antigo."
    );
    error.status = 404;
    throw error;
  }

  // A migração automática só é feita com e-mail confirmado. Isso impede que
  // uma conta não verificada tente assumir um perfil antigo apenas por e-mail.
  if (authUser.emailVerified !== true) {
    const error = new Error(
      "O perfil atual não foi encontrado e o e-mail da conta ainda não está confirmado. Confirme o e-mail antes de reparar o perfil."
    );
    error.status = 403;
    throw error;
  }

  const legacy = await findLegacyProfileByEmail(adminDb, email, currentUid);

  if (legacy.ambiguous) {
    const error = new Error(
      "Foram encontrados vários perfis antigos com este e-mail. A migração automática foi interrompida para evitar conflito."
    );
    error.status = 409;
    throw error;
  }

  if (!legacy.snapshot) {
    const error = new Error("Perfil da conta não encontrado no Firestore.");
    error.status = 404;
    throw error;
  }

  const legacyData = legacy.snapshot.data() || {};

  // Copia o perfil para o UID REAL que o Firebase Authentication está usando.
  // O documento antigo é preservado por segurança nesta primeira etapa.
  const migratedData = {
    ...legacyData,
    email,
    migratedFromUid: legacy.snapshot.id,
    migratedToUid: currentUid,
    migratedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  await currentRef.set(migratedData, { merge: false });

  const migratedSnapshot = await currentRef.get();

  return {
    snapshot: migratedSnapshot,
    migrated: true,
    migratedFromUid: legacy.snapshot.id
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    try {
      getAdminApp();
      return send(res, 200, {
        ok: true,
        service: "TechLib Session API",
        configured: true,
        version: "uid-profile-repair-v1"
      });
    } catch (error) {
      return send(res, 500, {
        ok: false,
        configured: false,
        error: error.message
      });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { ok: false, error: "Método não permitido." });
  }

  try {
    const token = getBearerToken(req);

    if (!token) {
      return send(res, 401, {
        ok: false,
        error: "Token de autenticação não enviado."
      });
    }

    const app = getAdminApp();
    const adminAuth = getAuth(app);
    const adminDb = getFirestore(app);

    let decoded;

    try {
      decoded = await adminAuth.verifyIdToken(token);
    } catch (error) {
      console.error("TechLib session verifyIdToken:", error);
      return send(res, 401, {
        ok: false,
        error: "Sessão inválida ou expirada. Entre novamente no TechLib."
      });
    }

    const authUser = await adminAuth.getUser(decoded.uid);

    const repaired = await ensureCurrentUidProfile(adminDb, authUser);
    const profileData = repaired.snapshot.data() || {};
    const profile = normalizeProfile(decoded.uid, authUser, profileData);

    return send(res, 200, {
      ok: true,
      profile,
      auth: {
        uid: decoded.uid,
        email: normalizeEmail(authUser.email || decoded.email),
        emailVerified: authUser.emailVerified === true,
        operatorClaim: decoded.operator === true
      },
      repair: {
        migrated: repaired.migrated,
        migratedFromUid: repaired.migratedFromUid
      }
    });
  } catch (error) {
    console.error("TechLib session API:", error);

    const status = Number(error.status) || 500;

    return send(res, status, {
      ok: false,
      error:
        status === 500
          ? "Não foi possível carregar ou reparar a sessão pelo servidor. Verifique os logs da API no Vercel."
          : error.message
    });
  }
}
