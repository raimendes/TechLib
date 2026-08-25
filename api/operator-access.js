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

async function requireLibraryManager(adminAuth, adminDb, req) {
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
  const role = String(manager.role || manager.baseRole || "");
  const active = manager.isActive !== false;

  if (!active || !["Administrador", "Bibliotecário"].includes(role)) {
    const error = new Error("Somente Administrador ou Bibliotecário pode alterar Alunos operadores.");
    error.status = 403;
    throw error;
  }

  return { uid: decoded.uid, role };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    try {
      getAdminApp();
      return send(res, 200, {
        ok: true,
        service: "TechLib Operator Access API",
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
    const app = getAdminApp();
    const adminAuth = getAuth(app);
    const adminDb = getFirestore(app);

    const manager = await requireLibraryManager(adminAuth, adminDb, req);

    const action = String(req.body?.action || "").trim();
    const uid = String(req.body?.uid || "").trim();

    if (!["grant", "revoke"].includes(action)) {
      return send(res, 400, { ok: false, error: "Ação inválida." });
    }

    if (!uid || uid.length > 256) {
      return send(res, 400, { ok: false, error: "UID do aluno inválido." });
    }

    if (uid === manager.uid) {
      return send(res, 400, { ok: false, error: "Não é possível alterar o próprio acesso por esta função." });
    }

    const targetUser = await adminAuth.getUser(uid);
    const targetEmail = String(targetUser.email || "").toLowerCase();

    if (!targetEmail.endsWith("@estudante.rn.gov.br")) {
      return send(res, 400, {
        ok: false,
        error: "A permissão de Aluno operador só pode ser concedida a uma conta de estudante."
      });
    }

    const targetRef = adminDb.doc(`users/${uid}`);
    const targetSnapshot = await targetRef.get();

    if (!targetSnapshot.exists) {
      return send(res, 404, {
        ok: false,
        error: "O perfil do aluno ainda não existe na coleção users do Firestore."
      });
    }

    const targetProfile = targetSnapshot.data() || {};
    if (targetProfile.baseRole !== "Aluno") {
      return send(res, 400, {
        ok: false,
        error: "O perfil selecionado não é um aluno."
      });
    }

    if (targetProfile.isActive === false && action === "grant") {
      return send(res, 400, {
        ok: false,
        error: "Reative o perfil do aluno antes de conceder acesso de operador."
      });
    }

    const claims = { ...(targetUser.customClaims || {}) };

    if (action === "grant") {
      claims.operator = true;
    } else {
      delete claims.operator;
    }

    await adminAuth.setCustomUserClaims(uid, claims);

    try {
      await targetRef.set(
        {
          // Mantém o perfil-base do estudante simples. A autorização real fica na claim.
          role: "Aluno",
          operatorEnabled: action === "grant",
          operatorUpdatedAt: FieldValue.serverTimestamp(),
          operatorUpdatedByUid: manager.uid,
          operatorUpdatedByRole: manager.role,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    } catch (mirrorError) {
      // Se o espelho no Firestore falhar durante a concessão, desfazemos a claim
      // para evitar divergência entre a interface e a autorização real.
      if (action === "grant") {
        const rollbackClaims = { ...(targetUser.customClaims || {}) };
        delete rollbackClaims.operator;
        await adminAuth.setCustomUserClaims(uid, rollbackClaims);
      }
      throw mirrorError;
    }

    if (action === "revoke") {
      // Impede a emissão de novos tokens a partir da sessão antiga.
      // Um ID token já emitido pode continuar válido até expirar; por isso o aluno
      // deve sair e entrar novamente para refletir a remoção imediatamente.
      await adminAuth.revokeRefreshTokens(uid);
    }

    return send(res, 200, {
      ok: true,
      uid,
      operator: action === "grant",
      message: action === "grant"
        ? "Acesso de Aluno operador concedido."
        : "Acesso de Aluno operador removido."
    });
  } catch (error) {
    console.error("TechLib operator-access API:", error);
    const status = Number(error.status) || 500;
    return send(res, status, {
      ok: false,
      error: status === 500
        ? "Não foi possível concluir a alteração de acesso no servidor. Verifique a configuração da API no Vercel."
        : error.message
    });
  }
}
