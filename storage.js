export function createLocalStorageService(dependencies) {
  const {
    LOCAL_MODE,
    state,
    BOOK_CONDITIONS,
    BOOK_DAMAGES,
    sortBooks,
    renderAll,
    updateAccessState,
    sanitizeCoverUrl,
    sanitizeExternalUrl,
    findBookDuplicate,
    displayBookField,
    getBookPendingLoans,
    getBookPendingReservations,
    isStudentUser,
    getUserOpenLoan,
    getAvailableCopies,
    setView,
    addDays,
    todayInputValue,
    getEffectiveRole
  } = dependencies;
const LOCAL_STORAGE_KEYS = {
  books: "techlibLocalBooksV3",
  loans: "techlibLocalLoansV3",
  reservations: "techlibLocalReservationsV3",
  events: "techlibLocalEventsV3",
  tavola: "techlibLocalTavolaV3",
  users: "techlibLocalUsersV3",
  session: "techlibLocalSessionV3"
};

function localId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function localTimestamp() {
  return new Date().toISOString();
}

function readLocalArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function getDefaultLocalUsers() {
  return [];
}

const LEGACY_TEST_USER_IDS = new Set([
  "test-professor",
  "test-student",
  "test-librarian",
  "test-admin",
  "test-authorized-student"
]);

function persistLocalData() {
  if (!LOCAL_MODE) return;
  localStorage.setItem(LOCAL_STORAGE_KEYS.books, JSON.stringify(state.books));
  localStorage.setItem(LOCAL_STORAGE_KEYS.loans, JSON.stringify(state.loans));
  localStorage.setItem(LOCAL_STORAGE_KEYS.reservations, JSON.stringify(state.reservations));
  localStorage.setItem(LOCAL_STORAGE_KEYS.events, JSON.stringify(state.events));
  localStorage.setItem(LOCAL_STORAGE_KEYS.tavola, JSON.stringify(state.tavolaRecords));
  localStorage.setItem(LOCAL_STORAGE_KEYS.users, JSON.stringify(state.users));
}

function loadLocalData() {
  const savedUsers = readLocalArray(LOCAL_STORAGE_KEYS.users)
    .filter(user => !LEGACY_TEST_USER_IDS.has(user.uid));
  const defaults = getDefaultLocalUsers();
  const byUid = new Map(savedUsers.map(user => [user.uid, user]));

  defaults.forEach(user => {
    if (!byUid.has(user.uid)) byUid.set(user.uid, user);
  });

  state.users = [...byUid.values()].map(user => ({
    ...user,
    isActive: user.isActive !== false
  }));
  state.books = readLocalArray(LOCAL_STORAGE_KEYS.books);
  state.loans = readLocalArray(LOCAL_STORAGE_KEYS.loans);
  state.reservations = readLocalArray(LOCAL_STORAGE_KEYS.reservations);
  state.events = readLocalArray(LOCAL_STORAGE_KEYS.events);
  state.tavolaRecords = readLocalArray(LOCAL_STORAGE_KEYS.tavola);
  state.booksLoaded = true;
  state.eventsLoaded = true;
  state.tavolaLoaded = true;
  state.privateDataLoaded = true;
  sortBooks();

  const sessionUid = localStorage.getItem(LOCAL_STORAGE_KEYS.session);
  if (sessionUid) {
    const savedUser = state.users.find(user => user.uid === sessionUid);
    if (savedUser) {
      state.currentUser = { ...savedUser, emailVerified: true };
      state.authUser = { uid: savedUser.uid, email: savedUser.email, emailVerified: true };
    }
  }
}

function refreshLocalState(message = "") {
  persistLocalData();
  sortBooks();
  renderAll();
  updateAccessState();
  if (message) alert(message);
}

function localSaveEvent(event) {
  const form = event.currentTarget;
  const data = new FormData(form);
  const title = String(data.get("title") || "").trim();
  const date = String(data.get("date") || "").trim();
  const time = String(data.get("time") || "").trim();
  const location = String(data.get("location") || "").trim();
  const description = String(data.get("description") || "").trim();
  const imageUrl = sanitizeCoverUrl(data.get("imageUrl"));

  if (!title || !date || !description) {
    alert("Preencha o nome, a data e a descrição do evento.");
    return;
  }

  const now = localTimestamp();
  if (state.editingEventId) {
    const record = state.events.find(item => item.id === state.editingEventId);
    if (!record) return;
    Object.assign(record, {
      title, date, time, location, description, imageUrl,
      updatedByUid: state.currentUser.uid,
      updatedByName: state.currentUser.name,
      updatedAt: now
    });
  } else {
    state.events.unshift({
      id: localId("event"),
      title, date, time, location, description, imageUrl,
      createdByUid: state.currentUser.uid,
      createdByName: state.currentUser.name,
      createdAt: now,
      updatedAt: now
    });
  }

  state.eventFormOpen = false;
  state.editingEventId = null;
  refreshLocalState("Evento salvo no modo local.");
}

function localRemoveEvent(eventId) {
  const record = state.events.find(item => item.id === eventId);
  if (!record || !confirm(`Excluir o evento "${record.title}"?`)) return;
  state.events = state.events.filter(item => item.id !== eventId);
  refreshLocalState();
}

function localSaveTavolaRecord(event) {
  const form = event.currentTarget;
  const data = new FormData(form);
  const title = String(data.get("title") || "").trim();
  const date = String(data.get("date") || "").trim();
  const type = String(data.get("type") || "").trim();
  const description = String(data.get("description") || "").trim();
  const documentUrl = sanitizeExternalUrl(data.get("documentUrl"));
  const validTypes = ["Ata", "Registro", "Comunicado", "Outro"];

  if (!title || !date || !description || !validTypes.includes(type)) {
    alert("Preencha corretamente o título, a data, o tipo e a descrição.");
    return;
  }

  const now = localTimestamp();
  if (state.editingTavolaId) {
    const record = state.tavolaRecords.find(item => item.id === state.editingTavolaId);
    if (!record) return;
    Object.assign(record, {
      title, date, type, description, documentUrl,
      updatedByUid: state.currentUser.uid,
      updatedByName: state.currentUser.name,
      updatedAt: now
    });
  } else {
    state.tavolaRecords.unshift({
      id: localId("tavola"),
      title, date, type, description, documentUrl,
      createdByUid: state.currentUser.uid,
      createdByName: state.currentUser.name,
      createdAt: now,
      updatedAt: now
    });
  }

  state.tavolaFormOpen = false;
  state.editingTavolaId = null;
  refreshLocalState("Registro da Távola salvo no modo local.");
}

function localRemoveTavolaRecord(recordId) {
  const record = state.tavolaRecords.find(item => item.id === recordId);
  if (!record || !confirm(`Excluir o registro "${record.title}"?`)) return;
  state.tavolaRecords = state.tavolaRecords.filter(item => item.id !== recordId);
  refreshLocalState();
}

function localSaveBook(event) {
  const form = event.currentTarget;
  const data = new FormData(form);
  const title = String(data.get("title") || "").trim();
  const author = String(data.get("author") || "").trim();
  const genre = String(data.get("genre") || "").trim();
  const rawQuantity = String(data.get("quantity") ?? "").trim();
  const quantity = rawQuantity ? Number(rawQuantity) : null;
  const condition = String(data.get("condition") || "Não informado");
  const damage = String(data.get("damage") || "Não informado");
  const cover = sanitizeCoverUrl(data.get("cover"));
  const editing = Boolean(state.editingBookId);

  if (!editing && (!title || !author || !genre || !rawQuantity)) {
    return alert("No cadastro manual, preencha Título, Autor, Gênero ou CDU e Quantidade.");
  }

  if (rawQuantity && (!Number.isInteger(quantity) || quantity < 1 || quantity > 999)) {
    return alert("Informe uma quantidade válida entre 1 e 999.");
  }

  if (!BOOK_CONDITIONS.includes(condition) || !BOOK_DAMAGES.includes(damage)) {
    return alert("Selecione um estado e uma situação válidos.");
  }

  const duplicate = findBookDuplicate(
    { title, author, genre },
    state.books,
    state.editingBookId
  );
  if (duplicate) {
    return alert(
      duplicate.type === "exact"
        ? `Já existe exemplar cadastrado para "${displayBookField(duplicate.book.title)}" com este autor. Edite o registro existente.`
        : `Já existe um possível exemplar deste título no acervo. Confira o registro "${displayBookField(duplicate.book.title)}" antes de salvar.`
    );
  }

  const now = localTimestamp();
  if (editing) {
    const book = state.books.find(item => item.id === state.editingBookId);
    if (!book) return;
    const occupied = Number(book.loanedCount || 0) + Number(book.reservedCount || 0);

    if (quantity === null && occupied > 0) {
      return alert("A quantidade não pode ficar sem informação enquanto houver empréstimo ou reserva.");
    }
    if (quantity !== null && quantity < occupied) {
      return alert(`A quantidade não pode ser menor que os ${occupied} exemplar(es) ocupados.`);
    }
    if (condition === "Inutilizável" && occupied > 0) {
      return alert("Não é possível marcar como inutilizável enquanto houver empréstimo ou reserva.");
    }

    Object.assign(book, {
      title, author, genre, quantity, condition, damage, cover,
      updatedBy: state.currentUser.uid,
      updatedAt: now
    });
  } else {
    state.books.push({
      id: localId("book"),
      title, author, genre, quantity,
      loanedCount: 0,
      reservedCount: 0,
      condition, damage, cover,
      createdBy: state.currentUser.uid,
      createdAt: now,
      updatedAt: now
    });
  }

  state.bookFormOpen = false;
  state.editingBookId = null;
  refreshLocalState("Livro salvo no modo local.");
}

function localRemoveBook(bookId) {
  const book = state.books.find(item => item.id === bookId);
  if (!book) return;

  if (
    book.loanedCount ||
    book.reservedCount ||
    getBookPendingLoans(bookId).length ||
    getBookPendingReservations(bookId).length
  ) {
    alert("Não é possível remover um livro com empréstimo, reserva ou solicitação pendente.");
    return;
  }

  if (!confirm(`Remover o livro "${book.title}" do acervo?`)) return;
  state.books = state.books.filter(item => item.id !== bookId);
  refreshLocalState();
}

function localRequestLoan(bookId) {
  if (!state.currentUser || !isStudentUser()) return;
  if (getUserOpenLoan()) {
    return alert("Você já possui um empréstimo ou solicitação em aberto.");
  }

  const book = state.books.find(item => item.id === bookId);
  if (!book || getAvailableCopies(book) < 1) {
    return alert("Este livro não está disponível.");
  }

  const now = localTimestamp();
  state.loans.unshift({
    id: localId("loan"),
    bookId,
    studentUid: state.currentUser.uid,
    studentName: state.currentUser.name,
    studentEmail: state.currentUser.email,
    status: "pending",
    renewed: false,
    renewalRequested: false,
    createdAt: now,
    updatedAt: now
  });

  refreshLocalState("Solicitação enviada. Aguarde a confirmação de um operador.");
  setView("loans");
}

function localCancelLoanRequest(loanId) {
  const record = state.loans.find(item => item.id === loanId);
  if (!record || record.studentUid !== state.currentUser?.uid || record.status !== "pending") return;
  record.status = "cancelled";
  record.updatedAt = localTimestamp();
  refreshLocalState();
}

function localConfirmLoan(loanId) {
  const record = state.loans.find(item => item.id === loanId);
  if (!record || record.status !== "pending") return;
  const book = state.books.find(item => item.id === record.bookId);
  if (!book || getAvailableCopies(book) < 1) {
    return alert("Não há exemplar disponível para confirmar.");
  }

  const now = new Date();
  book.loanedCount = Number(book.loanedCount || 0) + 1;
  record.status = "active";
  record.startDate = now.toISOString();
  record.dueDate = addDays(now, 15).toISOString();
  record.confirmedAt = now.toISOString();
  record.confirmedByUid = state.currentUser.uid;
  record.confirmedByName = state.currentUser.name;
  record.updatedAt = now.toISOString();
  refreshLocalState("Empréstimo confirmado por 15 dias.");
}

function localRejectLoan(loanId) {
  const record = state.loans.find(item => item.id === loanId);
  if (!record || record.status !== "pending") return;
  record.status = "rejected";
  record.updatedAt = localTimestamp();
  refreshLocalState();
}

function localRequestRenewal(loanId) {
  const record = state.loans.find(item => item.id === loanId);
  if (
    !record ||
    record.studentUid !== state.currentUser?.uid ||
    record.status !== "active" ||
    record.renewed ||
    record.renewalRequested
  ) return;

  record.renewalRequested = true;
  record.updatedAt = localTimestamp();
  refreshLocalState();
}

function localConfirmRenewal(loanId) {
  const record = state.loans.find(item => item.id === loanId);
  if (!record || record.status !== "active" || record.renewed) return;
  const dueDate = new Date(record.dueDate);
  if (Number.isNaN(dueDate.getTime())) return alert("Data de devolução inválida.");

  record.dueDate = addDays(dueDate, 15).toISOString();
  record.renewed = true;
  record.renewalRequested = false;
  record.renewedAt = localTimestamp();
  record.renewedByUid = state.currentUser.uid;
  record.updatedAt = localTimestamp();
  refreshLocalState("Renovação confirmada por mais 15 dias.");
}

function localRejectRenewal(loanId) {
  const record = state.loans.find(item => item.id === loanId);
  if (!record) return;
  record.renewalRequested = false;
  record.updatedAt = localTimestamp();
  refreshLocalState();
}

function localReturnLoan(loanId) {
  const record = state.loans.find(item => item.id === loanId);
  if (!record || record.status !== "active") return;
  const book = state.books.find(item => item.id === record.bookId);
  if (book) book.loanedCount = Math.max(0, Number(book.loanedCount || 0) - 1);

  record.status = "returned";
  record.returnedAt = localTimestamp();
  record.returnedByUid = state.currentUser.uid;
  record.updatedAt = localTimestamp();
  refreshLocalState("Devolução registrada e exemplar liberado.");
}

function localSaveReservation(event) {
  const form = event.currentTarget;
  const data = new FormData(form);
  const bookId = String(data.get("bookId") || "");
  const className = String(data.get("className") || "").trim();
  const quantity = Number(data.get("quantity"));
  const reservationDate = String(data.get("reservationDate") || "");
  const notes = String(data.get("notes") || "").trim();
  const book = state.books.find(item => item.id === bookId);

  if (!book || !className || !reservationDate) return alert("Preencha os campos obrigatórios.");
  if (!Number.isInteger(quantity) || quantity < 1) return alert("Informe uma quantidade válida.");
  if (quantity > getAvailableCopies(book)) return alert("A quantidade solicitada é maior que a disponível.");
  if (reservationDate < todayInputValue()) return alert("Selecione uma data atual ou futura.");

  const now = localTimestamp();
  state.reservations.unshift({
    id: localId("reservation"),
    bookId,
    teacherUid: state.currentUser.uid,
    teacherName: state.currentUser.name,
    teacherEmail: state.currentUser.email,
    className,
    quantity,
    reservationDate,
    notes,
    status: "pending",
    createdAt: now,
    updatedAt: now
  });
  form.reset();
  refreshLocalState("Reserva enviada para confirmação.");
}

function localCancelReservation(reservationId) {
  const record = state.reservations.find(item => item.id === reservationId);
  if (!record || record.teacherUid !== state.currentUser?.uid || record.status !== "pending") return;
  record.status = "cancelled";
  record.updatedAt = localTimestamp();
  refreshLocalState();
}

function localConfirmReservation(reservationId) {
  const record = state.reservations.find(item => item.id === reservationId);
  if (!record || record.status !== "pending") return;
  const book = state.books.find(item => item.id === record.bookId);
  if (!book || getAvailableCopies(book) < Number(record.quantity)) {
    return alert("Não há exemplares suficientes para confirmar a reserva.");
  }

  book.reservedCount = Number(book.reservedCount || 0) + Number(record.quantity);
  record.status = "active";
  record.confirmedAt = localTimestamp();
  record.confirmedByUid = state.currentUser.uid;
  record.confirmedByName = state.currentUser.name;
  record.updatedAt = localTimestamp();
  refreshLocalState("Reserva confirmada e exemplares separados.");
}

function localRejectReservation(reservationId) {
  const record = state.reservations.find(item => item.id === reservationId);
  if (!record || record.status !== "pending") return;
  record.status = "rejected";
  record.updatedAt = localTimestamp();
  refreshLocalState();
}

function localFinishReservation(reservationId, finalStatus) {
  if (!["completed", "cancelled"].includes(finalStatus)) return;
  const record = state.reservations.find(item => item.id === reservationId);
  if (!record || record.status !== "active") return;
  const book = state.books.find(item => item.id === record.bookId);
  if (book) {
    book.reservedCount = Math.max(
      0,
      Number(book.reservedCount || 0) - Number(record.quantity)
    );
  }

  record.status = finalStatus;
  record.finishedAt = localTimestamp();
  record.finishedByUid = state.currentUser.uid;
  record.updatedAt = localTimestamp();
  refreshLocalState();
}

function localToggleStudentPermission(uid, grant) {
  const user = state.users.find(item => item.uid === uid);
  if (!user || user.baseRole !== "Aluno") return;

  user.operatorEnabled = Boolean(grant);
  if (state.currentUser?.uid === uid) {
    state.authClaims = { ...state.authClaims, operator: Boolean(grant) };
  }

  state.studentPermissionSearch = "";
  refreshLocalState(
    grant
      ? "Acesso de aluno operador concedido."
      : "Acesso de aluno operador removido."
  );
}

function localChangeStaffRole(uid, role) {
  if (!["Professor", "Bibliotecário", "Administrador"].includes(role)) return;
  if (uid === state.currentUser?.uid) {
    return alert("O administrador não pode alterar o próprio perfil nesta tela.");
  }

  const user = state.users.find(item => item.uid === uid);
  if (!user || user.baseRole !== "Professor") return;
  user.role = role;
  refreshLocalState();
}


function localToggleUserActiveStatus(uid, activate) {
  const target = state.users.find(user => user.uid === uid);
  if (!target) return;

  if (uid === state.currentUser?.uid) {
    alert("Você não pode desativar o próprio perfil.");
    return;
  }

  const effectiveRole = getEffectiveRole();
  const admin = effectiveRole === "Administrador";
  const librarianCanManage =
    effectiveRole === "Bibliotecário" && target.baseRole === "Aluno";

  if (!admin && !librarianCanManage) return;

  target.isActive = Boolean(activate);
  if (!activate && target.baseRole === "Aluno") {
    target.operatorEnabled = false;
  }

  state.studentPermissionSearch = "";
  refreshLocalState(activate ? "Perfil reativado." : "Perfil desativado.");
}
  return {
    loadLocalData,
    localCancelLoanRequest,
    localCancelReservation,
    localChangeStaffRole,
    localConfirmLoan,
    localConfirmRenewal,
    localConfirmReservation,
    localFinishReservation,
    localRejectLoan,
    localRejectRenewal,
    localRejectReservation,
    localRemoveBook,
    localRemoveEvent,
    localRemoveTavolaRecord,
    localRequestLoan,
    localRequestRenewal,
    localReturnLoan,
    localSaveBook,
    localSaveEvent,
    localSaveReservation,
    localSaveTavolaRecord,
    localToggleStudentPermission,
    localToggleUserActiveStatus,
    persistLocalData
  };
}