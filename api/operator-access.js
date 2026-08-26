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
  const role = String(manager.role || manager.baseRole || "").trim();
  const active = manager.isActive !== false;

  if (!active || !["Administrador", "Bibliotecário"].includes(role)) {
    const error = new Error(
      "Somente Administrador ou Bibliotecário pode alterar Alunos operadores."
    );
    error.status = 403;
    throw error;
  }

  return {
    uid: decoded.uid,
    role,
    email: normalizeEmail(decoded.email)
  };
}

async function resolveTargetStudent(adminAuth, adminDb, requestedUid) {
  const requestedRef = adminDb.doc(`users/${requestedUid}`);
  const requestedSnapshot = await requestedRef.get();
  const requestedProfile = requestedSnapshot.exists
    ? requestedSnapshot.data() || {}
    : null;

  let authUser = null;
  let resolutionMethod = null;

  // 1) Se o UID recebido já for o UID atual do Authentication, usa diretamente.
  try {
    authUser = await adminAuth.getUser(requestedUid);
    resolutionMethod = "uid";
  } catch (error) {
    if (error?.code !== "auth/user-not-found") {
      throw error;
    }
  }

  // 2) Se o UID for de um documento antigo do Firestore, usa o e-mail desse
  // perfil para localizar a conta REAL no Firebase Authentication.
  if (!authUser && requestedProfile) {
    const legacyEmail = normalizeEmail(requestedProfile.email);

    if (legacyEmail) {
      try {
        authUser = await adminAuth.getUserByEmail(legacyEmail);
        resolutionMethod = "profile-email";
      } catch (error) {
        if (error?.code !== "auth/user-not-found") {
          throw error;
        }
      }
    }
  }

  if (!authUser) {
    const error = new Error(
      "Não foi possível localizar a conta atual do aluno no Firebase Authentication."
    );
    error.status = 404;
    throw error;
  }

  const realUid = authUser.uid;
  const realRef = adminDb.doc(`users/${realUid}`);
  let realSnapshot = await realRef.get();

  // 3) Se ainda não existir users/{UID real}, reaproveita o perfil selecionado
  // quando ele realmente for um perfil de aluno. Isso evita voltar ao UID antigo.
  if (!realSnapshot.exists && requestedProfile) {
    const requestedBaseRole = String(requestedProfile.baseRole || "").trim();

    if (requestedBaseRole === "Aluno") {
      await realRef.set(
        {
          ...requestedProfile,
          email: normalizeEmail(authUser.email || requestedProfile.email),
          role: "Aluno",
          baseRole: "Aluno",
          migratedFromUid:
            requestedUid !== realUid
              ? requestedUid
              : requestedProfile.migratedFromUid || null,
          migratedToUid: realUid,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: false }
      );

      realSnapshot = await realRef.get();
    }
  }

  if (!realSnapshot.exists) {
    const error = new Error(
      "O perfil atual do aluno ainda não existe em users/{UID real}. Entre uma vez na conta do aluno para a API de sessão reparar o perfil."
    );
    error.status = 404;
    throw error;
  }

  const realProfile = realSnapshot.data() || {};
  const realBaseRole = String(realProfile.baseRole || "").trim();

  if (realBaseRole !== "Aluno") {
    const error = new Error(
      "A permissão de Aluno operador só pode ser concedida a um perfil de aluno."
    );
    error.status = 400;
    throw error;
  }

  return {
    requestedUid,
    requestedRef,
    requestedSnapshot,
    requestedProfile,
    authUser,
    realUid,
    realRef,
    realSnapshot,
    realProfile,
    resolutionMethod
  };
}

async function setOperatorState({
  adminAuth,
  adminDb,
  target,
  manager,
  enabled
}) {
  const { authUser, realUid, realRef, requestedUid, requestedRef } = target;

  if (target.realProfile.isActive === false && enabled) {
    const error = new Error(
      "Reative o perfil do aluno antes de conceder acesso de operador."
    );
    error.status = 400;
    throw error;
  }

  // Mantém a claim sincronizada por compatibilidade com a versão atual do site,
  // mas o UID usado é sempre o UID REAL do Firebase Authentication.
  const claims = { ...(authUser.customClaims || {}) };

  if (enabled) {
    claims.operator = true;
  } else {
    delete claims.operator;
  }

  await adminAuth.setCustomUserClaims(realUid, claims);

  try {
    const batch = adminDb.batch();

    batch.set(
      realRef,
      {
        role: "Aluno",
        baseRole: "Aluno",
        operatorEnabled: enabled,
        operatorUpdatedAt: FieldValue.serverTimestamp(),
        operatorUpdatedByUid: manager.uid,
        operatorUpdatedByRole: manager.role,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    // Se a tela administrativa enviou um UID antigo, limpamos o espelho de
    // operador nesse documento para impedir que o sistema continue mostrando
    // o perfil antigo como autorizado.
    if (requestedUid !== realUid && target.requestedSnapshot.exists) {
      batch.set(
        requestedRef,
        {
          operatorEnabled: false,
          operatorMigratedToUid: realUid,
          operatorUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }

    await batch.commit();
  } catch (firestoreError) {
    // Evita divergência: se o Firestore falhar durante a concessão,
    // remove a claim que acabou de ser aplicada.
    if (enabled) {
      const rollbackClaims = { ...(authUser.customClaims || {}) };
      delete rollbackClaims.operator;
      await adminAuth.setCustomUserClaims(realUid, rollbackClaims);
    }

    throw firestoreError;
  }

  if (!enabled) {
    await adminAuth.revokeRefreshTokens(realUid);
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    try {
      getAdminApp();

      return send(res, 200, {
        ok: true,
        service: "TechLib Operator Access API",
        configured: true,
        version: "real-auth-uid-v1"
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

    const manager = await requireLibraryManager(adminAuth, adminDb, req);

    const action = String(req.body?.action || "").trim();
    const requestedUid = String(req.body?.uid || "").trim();

    if (!["grant", "revoke"].includes(action)) {
      return send(res, 400, {
        ok: false,
        error: "Ação inválida."
      });
    }

    if (!requestedUid || requestedUid.length > 256) {
      return send(res, 400, {
        ok: false,
        error: "UID do aluno inválido."
      });
    }

    const target = await resolveTargetStudent(
      adminAuth,
      adminDb,
      requestedUid
    );

    if (target.realUid === manager.uid) {
      return send(res, 400, {
        ok: false,
        error: "Não é possível alterar o próprio acesso por esta função."
      });
    }

    const enabled = action === "grant";

    await setOperatorState({
      adminAuth,
      adminDb,
      target,
      manager,
      enabled
    });

    return send(res, 200, {
      ok: true,
      requestedUid,
      uid: target.realUid,
      email: normalizeEmail(target.authUser.email),
      operator: enabled,
      resolvedBy: target.resolutionMethod,
      correctedUid: requestedUid !== target.realUid,
      message: enabled
        ? "Acesso de Aluno operador concedido no UID atual da conta."
        : "Acesso de Aluno operador removido do UID atual da conta."
    });
  } catch (error) {
    console.error("TechLib operator-access API:", error);

    const status = Number(error.status) || 500;

    return send(res, status, {
      ok: false,
      error:
        status === 500
          ? "Não foi possível concluir a alteração de acesso no servidor. Verifique os logs da API no Vercel."
          : error.message
    });
  }
}
