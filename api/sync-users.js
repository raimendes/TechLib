// TechLib - Sincronização administrativa de usuários
// Firebase Authentication → Firestore users/{uid}

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
  return res.status(status).json(body);
}


function getBearerToken(req) {
  const header = String(req.headers.authorization || "");

  if (!header.startsWith("Bearer ")) {
    return "";
  }

  return header.slice(7).trim();
}


async function requireAdmin(adminAuth, adminDb, req) {

  const token = getBearerToken(req);

  if (!token) {
    throw {
      status: 401,
      message: "Token de autenticação não enviado."
    };
  }


  let decoded;

  try {
    decoded = await adminAuth.verifyIdToken(token);
  } catch {
    throw {
      status: 401,
      message: "Sessão inválida ou expirada."
    };
  }


  if (decoded.email_verified !== true) {
    throw {
      status: 403,
      message: "E-mail da conta administrativa não confirmado."
    };
  }


  const profileSnapshot = await adminDb
    .doc(`users/${decoded.uid}`)
    .get();


  if (!profileSnapshot.exists) {
    throw {
      status: 403,
      message: "Perfil administrativo não encontrado."
    };
  }


  const profile = profileSnapshot.data() || {};

  const role = String(
    profile.role ||
    profile.baseRole ||
    ""
  ).trim();


  if (!["Administrador", "Bibliotecário"].includes(role)) {
    throw {
      status: 403,
      message: "Usuário sem permissão para sincronizar usuários."
    };
  }


  return decoded;
}



export default async function handler(req, res) {

  res.setHeader("Cache-Control", "no-store");


  try {

    const app = getAdminApp();

    const adminAuth = getAuth(app);

    const adminDb = getFirestore(app);


    if (req.method !== "POST") {

      return send(res, 405, {
        ok: false,
        checked: 0,
        created: 0,
        errors: [
          "Método não permitido."
        ]
      });

    }


    await requireAdmin(
      adminAuth,
      adminDb,
      req
    );


    let checked = 0;
    let created = 0;

    const errors = [];

    let pageToken;


    do {

      const result = await adminAuth.listUsers(
        1000,
        pageToken
      );


      for (const user of result.users) {

        checked++;


        try {

          const userRef = adminDb.doc(
            `users/${user.uid}`
          );


          const snapshot = await userRef.get();


          // Não altera perfis existentes
          if (snapshot.exists) {
            continue;
          }


          const email = String(
            user.email || ""
          ).toLowerCase();


          let role = "Aluno";


          if (
            email.endsWith("@educar.rn.gov.br")
          ) {
            role = "Professor";
          }


          await userRef.set({

            uid: user.uid,

            name:
              user.displayName ||
              email.split("@")[0] ||
              "Usuário TechLib",

            email,

            baseRole: role,

            role,

            isActive: true,

            operatorEnabled: false,

            emailVerified:
              Boolean(user.emailVerified),

            createdAt:
              FieldValue.serverTimestamp(),

            updatedAt:
              FieldValue.serverTimestamp()

          });


          created++;


        } catch(error) {

          errors.push({

            uid: user.uid,

            email: user.email || "",

            error: error.message

          });

        }

      }


      pageToken = result.pageToken;


    } while(pageToken);



    return send(res, 200, {

      ok: true,

      checked,

      created,

      errors

    });


  } catch(error) {

    console.error(
      "TechLib sync-users API:",
      error
    );


    return send(res, error.status || 500, {

      ok: false,

      checked: 0,

      created: 0,

      errors: [
        error.message ||
        "Erro interno no servidor."
      ]

    });

  }

}
