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

function normalizeProfile(uid, authUser, data = {}) {
  const baseRole = data.baseRole === "Professor" ? "Professor" : "Aluno";
  const allowedRoles = ["Aluno", "Professor", "Bibliotecário", "Administrador"];
  const role = allowedRoles.includes(data.role)
    ? data.role
    : baseRole;

  return {
    uid,
    name: String(data.name || authUser.displayName || "").trim(),
    email: String(data.email || authUser.email || "").toLowerCase(),
    baseRole,
    role,
    isActive: data.isActive !== false,
    operatorEnabled: data.operatorEnabled === true
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
        configured: true
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

    const [authUser, profileSnapshot] = await Promise.all([
      adminAuth.getUser(decoded.uid),
      adminDb.doc(`users/${decoded.uid}`).get()
    ]);

    if (!profileSnapshot.exists) {
      return send(res, 404, {
        ok: false,
        error: "Perfil da conta não encontrado no Firestore.",
        auth: {
          uid: decoded.uid,
          email: String(authUser.email || decoded.email || "").toLowerCase(),
          emailVerified: authUser.emailVerified === true
        }
      });
    }

    const profile = normalizeProfile(
      decoded.uid,
      authUser,
      profileSnapshot.data() || {}
    );

    return send(res, 200, {
      ok: true,
      profile,
      auth: {
        emailVerified: authUser.emailVerified === true,
        operatorClaim: decoded.operator === true
      }
    });
  } catch (error) {
    console.error("TechLib session API:", error);
    return send(res, 500, {
      ok: false,
      error: "Não foi possível carregar a sessão pelo servidor. Verifique os logs da API no Vercel."
    });
  }
}
