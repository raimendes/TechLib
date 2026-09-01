import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  reload,
  getIdToken,
  getIdTokenResult,
  updateProfile,
  verifyBeforeUpdateEmail
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  runTransaction,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

/*
  Configuração do projeto Firebase.
  Consulte: Console do Firebase > Configurações do projeto > Seus apps > Web.
*/
const firebaseConfig = {
  apiKey: "AIzaSyB46S94ee_c-00vExyjyRABDCEKHrr4Wy4",
  authDomain: "techlib-e308a.firebaseapp.com",
  projectId: "techlib-e308a",
  storageBucket: "techlib-e308a.firebasestorage.app",
  messagingSenderId: "63070344950",
  appId: "1:63070344950:web:44f731360f3baaccbb3ed7",
  measurementId: "G-4SS1CM5X4H"
};

const firebaseConfigured = Object.values(firebaseConfig).every(value => {
  const text = String(value || "");
  return text && !text.includes("COLE_AQUI");
});

function initializeFirebase() {
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

  return {
    auth: getAuth(app),
    db: getFirestore(app)
  };
}

export {
  addDoc,
  collection,
  createUserWithEmailAndPassword,
  deleteDoc,
  doc,
  firebaseConfigured,
  getDoc,
  getIdToken,
  getIdTokenResult,
  initializeFirebase,
  onAuthStateChanged,
  onSnapshot,
  query,
  reload,
  runTransaction,
  sendEmailVerification,
  sendPasswordResetEmail,
  serverTimestamp,
  setDoc,
  signInWithEmailAndPassword,
  signOut,
  Timestamp,
  updateDoc,
  updateProfile,
  verifyBeforeUpdateEmail,
  where,
  writeBatch
};
