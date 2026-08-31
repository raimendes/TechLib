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

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return "";
  return header.slice(7).trim();
}

async function requireAdministrator(adminAuth, adminDb, req) {
  const token = getBearerToken(req);

  if (!token) {
    const error = new Error("Token de autenticação não enviado.");
    error.status = 401;
    throw error;
  }

  let decoded;

  try {
    decoded = await adminAuth.verifyIdToken(token);
  } catch {
    const error = new Error("Sessão inválida ou expirada. Entre novamente no TechLib.");
    error.status = 401;
    throw error;
  }

  if (decoded.email_verified !== true) {
    const error = new Error("A conta administrativa precisa ter o e-mail confirmado.");
    error.status = 403;
    throw error;
  }

  const managerSnapshot = await adminDb.doc(`users/${decoded.uid}`).get();

  if (!managerSnapshot.exists) {
    const error = new Error("Perfil administrativo não encontrado no Firestore.");
    error.status = 403;
    throw error;
  }

  const manager = managerSnapshot.data() || {};
  const role = String(manager.role || manager.baseRole || "").trim();

  if (manager.isActive === false || role !== "Administrador") {
    const error = new Error("Somente Administrador pode excluir contas.");
    error.status = 403;
    throw error;
  }

  return {
    uid: decoded.uid,
    email: String(decoded.email || "").trim().toLowerCase()
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    try {
      getAdminApp();
      return send(res, 200, {
        ok: true,
        service: "TechLib Delete User API",
        configured: true,
        version: "delete-user-v1"
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
    return send(res, 405, {
      ok: false,
      error: "Método não permitido."
    });
  }

  try {
    const app = getAdminApp();
    const adminAuth = getAuth(app);
    const adminDb = getFirestore(app);

    const administrator = await requireAdministrator(adminAuth, adminDb, req);

    const action = String(req.body?.action || "").trim();
    const uid = String(req.body?.uid || "").trim();

    if (action !== "delete") {
      return send(res, 400, {
        ok: false,
        error: "Ação inválida."
      });
    }

    if (!uid || uid.length > 256) {
      return send(res, 400, {
        ok: false,
        error: "UID inválido."
      });
    }

    if (uid === administrator.uid) {
      return send(res, 400, {
        ok: false,
        error: "O Administrador não pode excluir a própria conta."
      });
    }

    const profileRef = adminDb.doc(`users/${uid}`);
    const profileSnapshot = await profileRef.get();

    if (!profileSnapshot.exists) {
      return send(res, 404, {
        ok: false,
        error: "Perfil do usuário não encontrado no Firestore."
      });
    }

    const profile = profileSnapshot.data() || {};
    const baseRole = String(profile.baseRole || "").trim();

    // Esta primeira versão libera exclusão pela tela de professores/perfis
    // administrativos. Alunos continuam com desativação e gestão própria.
    if (baseRole !== "Professor") {
      return send(res, 400, {
        ok: false,
        error: "Esta opção de exclusão está disponível somente para contas de Professor e perfis administrativos."
      });
    }

    let authDeleted = false;

    try {
      await adminAuth.deleteUser(uid);
      authDeleted = true;
    } catch (error) {
      if (error?.code !== "auth/user-not-found") {
        throw error;
      }
      // Se já não existir no Authentication, continua para remover o perfil órfão.
    }

    await profileRef.delete();

    return send(res, 200, {
      ok: true,
      uid,
      email: String(profile.email || "").trim().toLowerCase(),
      authDeleted,
      profileDeleted: true,
      message: "Conta removida do Firebase Authentication e do perfil do TechLib."
    });
  } catch (error) {
    console.error("TechLib delete-user API:", error);

    const status = Number(error.status) || 500;

    return send(res, status, {
      ok: false,
      error:
        status === 500
          ? "Não foi possível excluir a conta. Verifique os logs da API no Vercel."
          : error.message
    });
  }
}
