import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function bearer(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

async function requireManager(adminAuth, adminDb, req) {
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
    const error = new Error("A conta precisa ter o e-mail confirmado.");
    error.status = 403;
    throw error;
  }

  const profileSnapshot = await adminDb.doc(`users/${decoded.uid}`).get();
  if (!profileSnapshot.exists) {
    const error = new Error("Perfil administrativo não encontrado.");
    error.status = 403;
    throw error;
  }

  const profile = profileSnapshot.data() || {};
  const role = String(profile.role || profile.baseRole || "").trim();

  if (profile.isActive === false || !["Administrador", "Bibliotecário"].includes(role)) {
    const error = new Error(
      "Somente Administrador ou Bibliotecário pode consultar a gestão de alunos."
    );
    error.status = 403;
    throw error;
  }

  return { uid: decoded.uid, role };
}

async function listAllAuthUsers(adminAuth) {
  const result = [];
  let pageToken;

  do {
    const page = await adminAuth.listUsers(1000, pageToken);
    result.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);

  return result;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET" && !req.headers.authorization) {
    try {
      getAdminApp();
      return send(res, 200, {
        ok: true,
        service: "TechLib Students API",
        configured: true,
        version: "auth-source-v1"
      });
    } catch (error) {
      return send(res, 500, {
        ok: false,
        configured: false,
        error: error.message
      });
    }
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { ok: false, error: "Método não permitido." });
  }

  try {
    const app = getAdminApp();
    const adminAuth = getAuth(app);
    const adminDb = getFirestore(app);

    await requireManager(adminAuth, adminDb, req);

    const authUsers = await listAllAuthUsers(adminAuth);

    const students = [];

    for (const authUser of authUsers) {
      const email = normalizeEmail(authUser.email);

      // Fonte oficial: contas REAIS do Firebase Authentication com o domínio correto.
      if (!email.endsWith("@estudante.rn.gov.br")) continue;

      const profileSnapshot = await adminDb.doc(`users/${authUser.uid}`).get();
      const profile = profileSnapshot.exists ? profileSnapshot.data() || {} : {};

      students.push({
        uid: authUser.uid,
        name: String(
          profile.name ||
          authUser.displayName ||
          email.split("@")[0]
        ).trim(),
        email,
        emailVerified: authUser.emailVerified === true,
        isActive: profile.isActive !== false,
        baseRole: profile.baseRole === "Professor" ? "Professor" : "Aluno",
        role: ["Aluno", "Professor", "Bibliotecário", "Administrador"].includes(profile.role)
          ? profile.role
          : "Aluno",
        operatorEnabled: profile.operatorEnabled === true,
        operatorClaim: authUser.customClaims?.operator === true,
        profileExists: profileSnapshot.exists
      });
    }

    students.sort((a, b) =>
      a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" })
    );

    return send(res, 200, {
      ok: true,
      count: students.length,
      students
    });
  } catch (error) {
    console.error("TechLib students API:", error);

    const status = Number(error.status) || 500;

    return send(res, status, {
      ok: false,
      error:
        status === 500
          ? "Não foi possível carregar os alunos pelo servidor. Verifique os logs da API no Vercel."
          : error.message
    });
  }
}
