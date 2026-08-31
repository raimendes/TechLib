import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth, getIdToken } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyB46S94ee_c-00vExyjyRABDCEKHrr4Wy4",
  authDomain: "techlib-e308a.firebaseapp.com",
  projectId: "techlib-e308a",
  storageBucket: "techlib-e308a.firebasestorage.app",
  messagingSenderId: "63070344950",
  appId: "1:63070344950:web:44f731360f3baaccbb3ed7",
  measurementId: "G-4SS1CM5X4H"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);

function getUidFromStaffCard(card) {
  const button = card.querySelector('button[onclick*="toggleUserActiveStatus"]');
  const code = button?.getAttribute("onclick") || "";
  const match = code.match(/toggleUserActiveStatus\('([^']+)'/);
  return match?.[1] || "";
}

async function deleteAccount(uid, name, email, button) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    alert("Entre novamente na conta de Administrador.");
    return;
  }

  const firstConfirmation = confirm(
    `Excluir permanentemente a conta de ${name || email || "este usuário"}?\n\n` +
    "A conta será removida do Firebase Authentication e da lista de usuários do TechLib. " +
    "O histórico de empréstimos e reservas já registrado será preservado."
  );

  if (!firstConfirmation) return;

  const typed = prompt(
    `Para confirmar a exclusão de ${email || name}, digite EXCLUIR:`
  );

  if (typed !== "EXCLUIR") {
    alert("Exclusão cancelada.");
    return;
  }

  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = "Excluindo...";

  try {
    const token = await getIdToken(currentUser, true);

    const response = await fetch("/api/delete-user", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        action: "delete",
        uid
      })
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(payload.error || `A API respondeu com status ${response.status}.`);
    }

    alert("Conta excluída permanentemente.");
  } catch (error) {
    console.error("Erro ao excluir conta:", error);
    alert(error?.message || "Não foi possível excluir a conta.");
    button.disabled = false;
    button.textContent = previousText;
  }
}

function enhanceStaffCards() {
  const management = document.getElementById("managementContent");
  if (!management) return;

  const headings = [...management.querySelectorAll(".management-card h3")];
  const staffHeading = headings.find(
    heading => heading.textContent.trim() === "Professores e perfis administrativos"
  );

  const staffCard = staffHeading?.closest(".management-card");
  if (!staffCard) return;

  staffCard.querySelectorAll(".permission-user").forEach(card => {
    const actions = card.querySelector(".permission-actions");
    if (!actions || actions.querySelector("[data-delete-account]")) return;

    const uid = getUidFromStaffCard(card);

    // O próprio Administrador não possui o botão de ativar/desativar,
    // então também não recebe a opção de exclusão.
    if (!uid) return;

    const name = card.querySelector("strong")?.textContent?.trim() || "";
    const email = card.querySelector("span")?.textContent?.trim() || "";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "small-button danger-outline";
    button.dataset.deleteAccount = "true";
    button.textContent = "Excluir conta";
    button.addEventListener("click", () => deleteAccount(uid, name, email, button));

    actions.appendChild(button);
  });
}

const observer = new MutationObserver(() => enhanceStaffCards());

function start() {
  const management = document.getElementById("managementContent");
  if (!management) return;

  observer.observe(management, {
    childList: true,
    subtree: true
  });

  enhanceStaffCards();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
