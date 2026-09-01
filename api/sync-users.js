// TechLib - Sincronização administrativa de usuários
// Firebase Authentication → Firestore users/{uid}

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";


function getAdminApp() {

  if (getApps().length) {
    return getApps()[0];
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;


  if (!projectId || !clientEmail || !privateKey) {

    throw new Error(
      "Configuração Firebase Admin incompleta. Verifique FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY."
    );

  }


  return initializeApp({

    credential: cert({

      projectId,

      clientEmail,

      privateKey: privateKey.replace(/\\n/g, "\n")

    })

  });

}



function response(res, status, data) {

  return res.status(status).json(data);

}



function getToken(req) {

  const authorization = String(
    req.headers.authorization || ""
  );


  if (!authorization.startsWith("Bearer ")) {

    return null;

  }


  return authorization.substring(7);

}



async function validateAdmin(adminAuth, db, req) {


  const token = getToken(req);


  if (!token) {

    throw {
      status: 401,
      message: "Token não informado."
    };

  }



  let decoded;


  try {

    decoded = await adminAuth.verifyIdToken(token);

  } catch {

    throw {
      status: 401,
      message: "Token inválido ou expirado."
    };

  }



  if (!decoded.email_verified) {

    throw {
      status: 403,
      message: "E-mail ainda não confirmado."
    };

  }



  const profile = await db
    .collection("users")
    .doc(decoded.uid)
    .get();



  if (!profile.exists) {

    throw {
      status: 403,
      message: "Perfil do usuário não encontrado."
    };

  }



  const data = profile.data();



  const role = String(
    data.role ||
    data.baseRole ||
    ""
  ).trim();



  if (
    role !== "Administrador" &&
    role !== "Bibliotecário"
  ) {

    throw {
      status: 403,
      message: "Usuário sem permissão."
    };

  }


  return decoded;

}




export default async function handler(req, res) {


  res.setHeader(
    "Cache-Control",
    "no-store"
  );



  try {


    const app = getAdminApp();


    const adminAuth = getAuth(app);


    const db = getFirestore(app);



    if (req.method !== "POST") {


      return response(res, 405, {

        ok: false,

        checked: 0,

        created: 0,

        errors: [
          "Método não permitido."
        ]

      });


    }



    await validateAdmin(
      adminAuth,
      db,
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


          const userRef = db
            .collection("users")
            .doc(user.uid);



          const existing = await userRef.get();



          // Não altera usuários existentes
          if (existing.exists) {

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



        } catch (error) {


          errors.push({

            uid: user.uid,

            email: user.email || "",

            error: error.message

          });


        }


      }



      pageToken = result.pageToken;



    } while (pageToken);




    return response(res, 200, {


      ok: true,


      checked,


      created,


      errors


    });




  } catch (error) {



    console.error(
      "sync-users:",
      error
    );



    return response(
      res,
      error.status || 500,
      {


        ok: false,


        checked: 0,


        created: 0,


        errors: [

          error.message ||
          "Erro interno."

        ]

      }
    );


  }


}
