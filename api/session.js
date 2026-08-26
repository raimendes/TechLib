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

function inferBaseRoleFromEmail(email) {
  const normalized = normalizeEmail(email);
  if (normalized.endsWith("@estudante.rn.gov.br")) return "Aluno";
  if (normalized.endsWith("@educar.rn.gov.br")) return "Professor";
  return null;
}

function normalizeProfile(uid, authUser, data = {}) {
  const inferredBaseRole = inferBaseRoleFromEmail(authUser.email);
  const baseRole =
    data.baseRole === "Professor"
      ? "Professor"
      : data.baseRole === "Aluno"
        ? "Aluno"
        : inferredBaseRole || "Aluno";

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
    return { snapshot: null, ambiguous: false, method: null };
  }

  // 1) Busca exata, rápida.
  const exactQuery = await adminDb
    .collection("users")
    .where("email", "==", normalizedEmail)
    .limit(3)
    .get();

  const exactCandidates = exactQuery.docs.filter((doc) => doc.id !== currentUid);

  if (exactCandidates.length === 1) {
    return {
      snapshot: exactCandidates[0],
      ambiguous: false,
      method: "exact-email-query"
    };
  }

  if (exactCandidates.length > 1) {
    return { snapshot: null, ambiguous: true, method: "exact-email-query" };
  }

  // 2) Fallback de migração:
  // lê a coleção apenas quando a busca exata falha e compara e-mail normalizado.
  // Isso resolve perfis antigos que tenham espaços, maiúsculas ou formatação legada.
  const allUsers = await adminDb.collection("users").get();

  const normalizedCandidates = allUsers.docs.filter((doc) => {
    if (doc.id === currentUid) return false;
    const data = doc.data() || {};
    return normalizeEmail(data.email) === normalizedEmail;
  });

  if (normalizedCandidates.length === 1) {
    return {
      snapshot: normalizedCandidates[0],
      ambiguous: false,
      method: "normalized-collection-scan"
    };
  }

  if (normalizedCandidates.length > 1) {
    return {
      snapshot: null,
      ambiguous: true,
      method: "normalized-collection-scan"
    };
  }

  return { snapshot: null, ambiguous: false, method: "not-found" };
}

async function createSafeProfileForCurrentAuth(adminDb, authUser) {
  const email = normalizeEmail(authUser.email);
  const baseRole = inferBaseRoleFromEmail(email);

  if (!baseRole) {
    const error = new Error(
      "Não foi possível identificar se a conta pertence a aluno ou professor pelo domínio institucional."
    );
    error.status = 422;
    throw error;
  }

  const currentRef = adminDb.doc(`users/${authUser.uid}`);

  const data = {
    name: String(authUser.displayName || "").trim(),
    email,
    baseRole,
    role: baseRole,
    isActive: true,
    operatorEnabled: false,
    repairedFromAuthentication: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  await currentRef.set(data, { merge: false });
  return await currentRef.get();
}

async function ensureCurrentUidProfile(adminDb, authUser) {
  const currentUid = authUser.uid;
  const currentRef = adminDb.doc(`users/${currentUid}`);
  const currentSnapshot = await currentRef.get();

  if (currentSnapshot.exists) {
    return {
      snapshot: currentSnapshot,
      migrated: false,
      createdFromAuth: false,
      migratedFromUid: null,
      migrationMethod: "current-uid"
    };
  }

  const email = normalizeEmail(authUser.email);

  if (!email) {
    const error = new Error(
      "A conta autenticada não possui e-mail. Não foi possível localizar ou reconstruir o perfil."
    );
    error.status = 404;
    throw error;
  }

  if (authUser.emailVerified !== true) {
    const error = new Error(
      "O perfil atual não foi encontrado e o e-mail da conta ainda não está confirmado."
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

  if (legacy.snapshot) {
    const legacyData = legacy.snapshot.data() || {};

    const migratedData = {
      ...legacyData,
      email,
      migratedFromUid: legacy.snapshot.id,
      migratedToUid: currentUid,
      migrationMethod: legacy.method,
      migratedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    await currentRef.set(migratedData, { merge: false });
    const migratedSnapshot = await currentRef.get();

    return {
      snapshot: migratedSnapshot,
      migrated: true,
      createdFromAuth: false,
      migratedFromUid: legacy.snapshot.id,
      migrationMethod: legacy.method
    };
  }

  // 3) Se realmente não houver perfil antigo, cria um perfil seguro para o UID real.
  // Isso evita que uma conta válida e verificada fique eternamente sem users/{uid}.
  // Nenhuma permissão especial é criada aqui: operatorEnabled permanece false.
  const createdSnapshot = await createSafeProfileForCurrentAuth(adminDb, authUser);

  return {
    snapshot: createdSnapshot,
    migrated: false,
    createdFromAuth: true,
    migratedFromUid: null,
    migrationMethod: "created-from-auth"
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
        version: "uid-profile-repair-v2"
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
        createdFromAuth: repaired.createdFromAuth,
        migratedFromUid: repaired.migratedFromUid,
        migrationMethod: repaired.migrationMethod
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
