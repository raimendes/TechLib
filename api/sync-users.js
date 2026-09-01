// TechLib - Sincronização administrativa de usuários
// Firebase Authentication → Firestore users/{uid}

import admin from "firebase-admin";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido"
    });
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
        })
      });
    }

    const auth = admin.auth();
    const db = admin.firestore();

    let checked = 0;
    let created = 0;
    const errors = [];

    let nextPageToken;

    do {
      const result = await auth.listUsers(1000, nextPageToken);

      for (const user of result.users) {
        checked++;

        try {
          const userRef = db.collection("users").doc(user.uid);
          const snapshot = await userRef.get();

          // Usuário já possui perfil, não altera nada
          if (snapshot.exists) {
            continue;
          }

          const email = String(user.email || "").toLowerCase();

          let role = "Aluno";

          if (email.endsWith("@educar.rn.gov.br")) {
            role = "Professor";
          }

          const name =
            user.displayName ||
            email.split("@")[0] ||
            "Usuário TechLib";

          await userRef.set({
            uid: user.uid,
            name,
            email,
            baseRole: role,
            role,
            isActive: true,
            operatorEnabled: false,
            emailVerified: Boolean(user.emailVerified),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });

          created++;

        } catch (error) {
          errors.push({
            uid: user.uid,
            email: user.email,
            error: error.message
          });
        }
      }

      nextPageToken = result.pageToken;

    } while (nextPageToken);


    return res.status(200).json({
      success: true,
      checked,
      created,
      errors
    });


  } catch (error) {

    console.error("Erro na sincronização:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
