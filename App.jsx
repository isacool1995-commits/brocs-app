import React, { useState, useEffect, useMemo } from "react";
import { Users, CheckCircle2, Circle, ChevronLeft, Shield, Building2, Loader2, Plus, X, TrendingUp, LayoutGrid, BarChart3, PlusCircle, Filter, Download } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";
import * as XLSX from "xlsx";

const OWNER_LOGIN = "isa27";
const OWNER_PASSWORD = "46425";
const OWNER_RECOVERY_CODE = "brocs-2026"; // change this too — anyone who knows it can reset the owner password

function tierRateForPosition(n) {
  if (n <= 5) return 10000;
  if (n <= 30) return 15000;
  return 20000;
}
function managerEarnings(paidCount) {
  let total = 0;
  for (let n = 1; n <= paidCount; n++) total += tierRateForPosition(n);
  return total;
}
function currentTierLabel(paidCount) {
  if (paidCount < 5) return "1–5 клиентов · 10 000 ₸/клиент";
  if (paidCount < 30) return "6–30 клиентов · 15 000 ₸/клиент";
  return "30+ клиентов · 20 000 ₸/клиент";
}
const PARTNER_RATE = 15000;
const CLIENT_SERVICE_PRICE = 160000; // default price of the service, editable per client
const money = (n) => n.toLocaleString("ru-RU") + " ₸";
const uid = () => Math.random().toString(36).slice(2, 10);

async function loadList(key) {
  try {
    const res = await window.storage.get(key, true);
    return res ? JSON.parse(res.value) : [];
  } catch {
    return [];
  }
}
async function saveList(key, value) {
  try {
    await window.storage.set(key, JSON.stringify(value), true);
    return true;
  } catch {
    return false;
  }
}
async function loadValue(key, fallback) {
  try {
    const res = await window.storage.get(key, true);
    return res ? JSON.parse(res.value) : fallback;
  } catch {
    return fallback;
  }
}
async function saveValue(key, value) {
  try {
    await window.storage.set(key, JSON.stringify(value), true);
    return true;
  } catch {
    return false;
  }
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [managers, setManagers] = useState([]);
  const [partners, setPartners] = useState([]);
  const [clients, setClients] = useState([]);
  const [managerPayouts, setManagerPayouts] = useState([]);
  const [specialists, setSpecialists] = useState([]);
  const [ownerCreds, setOwnerCreds] = useState({ login: OWNER_LOGIN, password: OWNER_PASSWORD });
  const [role, setRole] = useState(null); // 'owner' | 'manager' | 'specialist'
  const [currentManagerId, setCurrentManagerId] = useState(null);
  const [currentSpecialistId, setCurrentSpecialistId] = useState(null);
  const [ownerLoginInput, setOwnerLoginInput] = useState("");
  const [ownerCodeInput, setOwnerCodeInput] = useState("");
  const [ownerError, setOwnerError] = useState("");
  const [selectedPartnerId, setSelectedPartnerId] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [m, p, c, mp, sp, oc] = await Promise.all([
        loadList("brocs_managers"),
        loadList("brocs_partners"),
        loadList("brocs_clients"),
        loadList("brocs_manager_payouts"),
        loadList("brocs_specialists"),
        loadValue("brocs_owner_creds", { login: OWNER_LOGIN, password: OWNER_PASSWORD }),
      ]);
      setManagers(m);
      setPartners(p);
      setClients(c);
      setManagerPayouts(mp);
      setSpecialists(sp);
      setOwnerCreds(oc);
      setLoading(false);
    })();
  }, []);

  const persistManagers = async (next) => {
    setManagers(next);
    setSaving(true);
    await saveList("brocs_managers", next);
    setSaving(false);
  };
  const persistPartners = async (next) => {
    setPartners(next);
    setSaving(true);
    await saveList("brocs_partners", next);
    setSaving(false);
  };
  const persistClients = async (next) => {
    setClients(next);
    setSaving(true);
    await saveList("brocs_clients", next);
    setSaving(false);
  };
  const persistSpecialists = async (next) => {
    setSpecialists(next);
    setSaving(true);
    await saveList("brocs_specialists", next);
    setSaving(false);
  };
  const persistManagerPayouts = async (next) => {
    setManagerPayouts(next);
    setSaving(true);
    await saveList("brocs_manager_payouts", next);
    setSaving(false);
  };

  const recoverOwnerCreds = async (newLogin, newPassword) => {
    const next = { login: newLogin, password: newPassword };
    setOwnerCreds(next);
    setSaving(true);
    await saveValue("brocs_owner_creds", next);
    setSaving(false);
  };

  const resetManagerPassword = async (managerId, newPassword) => {
    const next = managers.map((m) => (m.id === managerId ? { ...m, password: newPassword } : m));
    await persistManagers(next);
  };

  const resetSpecialistPassword = async (specialistId, newPassword) => {
    const next = specialists.map((s) => (s.id === specialistId ? { ...s, password: newPassword } : s));
    await persistSpecialists(next);
  };

  const paidCountForManager = (managerId) => {
    const partnerIds = partners.filter((p) => p.managerId === managerId).map((p) => p.id);
    return clients.filter((c) => partnerIds.includes(c.partnerId) && c.paid).length;
  };
  const paidCountForPartner = (partnerId) =>
    clients.filter((c) => c.partnerId === partnerId && c.paid).length;

  // Manager payouts are a proper log (date + amount), so nothing is ever silently
  // reset — "к выплате" is simply earned-to-date minus everything already logged as paid.
  const managerPaidOutTotal = (managerId) =>
    managerPayouts.filter((p) => p.managerId === managerId).reduce((s, p) => s + p.amount, 0);
  const managerOwed = (managerId) =>
    managerEarnings(paidCountForManager(managerId)) - managerPaidOutTotal(managerId);

  const payoutManager = async (managerId) => {
    const amount = managerOwed(managerId);
    if (amount <= 0) return;
    const record = {
      id: uid(),
      managerId,
      amount,
      date: new Date().toISOString(),
      clientsCountAtPayout: paidCountForManager(managerId),
    };
    await persistManagerPayouts([...managerPayouts, record]);
  };

  // Partner payouts are per-client rate (not a global flat rate) — each client stores
  // the rate that applied when it was added, so changing a partner's rate later only
  // affects new clients, not amounts already earned or paid out.
  const partnerEarnedTotal = (partnerId) =>
    clients.filter((c) => c.partnerId === partnerId && c.paid).reduce((s, c) => s + (c.rate ?? PARTNER_RATE), 0);
  const partnerPaidOutTotal = (partnerId) =>
    clients.filter((c) => c.partnerId === partnerId && c.partnerPaidAt).reduce((s, c) => s + (c.rate ?? PARTNER_RATE), 0);
  const partnerOwed = (partnerId) =>
    partnerEarnedTotal(partnerId) - partnerPaidOutTotal(partnerId);

  const updatePartnerRate = async (partnerId, newRate) => {
    const next = partners.map((p) => (p.id === partnerId ? { ...p, rate: newRate } : p));
    await persistPartners(next);
  };

  const updatePartnerInfo = async (partnerId, data) => {
    const next = partners.map((p) => (p.id === partnerId ? { ...p, ...data } : p));
    await persistPartners(next);
  };

  const updateClientAmount = async (clientId, newAmount) => {
    const next = clients.map((c) => (c.id === clientId ? { ...c, amount: newAmount } : c));
    await persistClients(next);
  };

  const updateClientInfo = async (clientId, data) => {
    const next = clients.map((c) => (c.id === clientId ? { ...c, ...data } : c));
    await persistClients(next);
  };

  const updateClientNote = async (clientId, note) => {
    const next = clients.map((c) => (c.id === clientId ? { ...c, note } : c));
    await persistClients(next);
  };

  const totalRevenue = clients.filter((c) => c.paid).reduce((s, c) => s + (c.amount ?? CLIENT_SERVICE_PRICE), 0);

  const toggleClientPartnerPaid = async (clientId) => {
    const next = clients.map((c) =>
      c.id === clientId ? { ...c, partnerPaidAt: c.partnerPaidAt ? null : new Date().toISOString() } : c
    );
    await persistClients(next);
  };

  // For a manager, each client's contribution depends on its position in the
  // chronological order clients were marked paid (tier rate depends on that position).
  const managerClientBreakdown = (managerId) => {
    const managerPartners = partners.filter((p) => p.managerId === managerId);
    const partnerIds = managerPartners.map((p) => p.id);
    const nameByPartnerId = Object.fromEntries(managerPartners.map((p) => [p.id, p.name]));
    const paidClients = clients
      .filter((c) => partnerIds.includes(c.partnerId) && c.paid)
      .sort((a, b) => new Date(a.paidAt || a.dateAdded) - new Date(b.paidAt || b.dateAdded));
    return paidClients.map((c, idx) => ({
      client: c,
      partnerName: nameByPartnerId[c.partnerId] || "",
      position: idx + 1,
      amount: tierRateForPosition(idx + 1),
    }));
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!role) {
    return (
      <RoleScreen
        onOwner={() => setRole("__owner_login__")}
        onManager={() => setRole("__manager_login__")}
        onSpecialist={() => setRole("__specialist_login__")}
      />
    );
  }

  if (role === "__owner_login__") {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 w-full max-w-sm">
          <Shield className="w-8 h-8 text-teal-700 mb-3" />
          <h2 className="text-lg font-semibold text-slate-800 mb-1">Вход владельца</h2>
          <p className="text-sm text-slate-500 mb-4">Введите логин и пароль</p>
          <input
            type="text"
            value={ownerLoginInput}
            onChange={(e) => setOwnerLoginInput(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 mb-2 focus:outline-none focus:ring-2 focus:ring-teal-600"
            placeholder="Логин"
            autoCapitalize="none"
          />
          <input
            type="password"
            value={ownerCodeInput}
            onChange={(e) => setOwnerCodeInput(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 mb-2 focus:outline-none focus:ring-2 focus:ring-teal-600"
            placeholder="Пароль"
          />
          {ownerError && <p className="text-sm text-red-600 mb-2">{ownerError}</p>}
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => setRole(null)}
              className="px-3 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-sm"
            >
              Назад
            </button>
            <button
              onClick={() => {
                if (ownerLoginInput === ownerCreds.login && ownerCodeInput === ownerCreds.password) {
                  setRole("owner");
                  setOwnerError("");
                } else {
                  setOwnerError("Неверный логин или пароль");
                }
              }}
              className="flex-1 bg-teal-700 text-white rounded-lg py-2 text-sm font-medium hover:bg-teal-800"
            >
              Войти
            </button>
          </div>
          <button
            onClick={() => setRole("__owner_recovery__")}
            className="w-full text-center text-teal-700 text-sm font-medium mt-3 hover:underline"
          >
            Забыли пароль?
          </button>
        </div>
      </div>
    );
  }

  if (role === "__owner_recovery__") {
    return (
      <OwnerRecovery
        onBack={() => setRole("__owner_login__")}
        onRecovered={async (newLogin, newPassword) => {
          await recoverOwnerCreds(newLogin, newPassword);
          setRole("owner");
        }}
      />
    );
  }

  if (role === "__specialist_login__") {
    return (
      <SpecialistLogin
        specialists={specialists}
        onBack={() => setRole(null)}
        onSelect={(id) => {
          setCurrentSpecialistId(id);
          setRole("specialist");
        }}
        onRegister={async (data) => {
          const newSpecialist = { id: uid(), ...data };
          await persistSpecialists([...specialists, newSpecialist]);
          setCurrentSpecialistId(newSpecialist.id);
          setRole("specialist");
        }}
        onResetPassword={resetSpecialistPassword}
      />
    );
  }

  if (role === "__manager_login__") {
    return (
      <ManagerLogin
        managers={managers}
        onBack={() => setRole(null)}
        onSelect={(id) => {
          setCurrentManagerId(id);
          setRole("manager");
        }}
        onRegister={async (data) => {
          const newManager = { id: uid(), ...data, startDate: new Date().toISOString().slice(0, 10) };
          await persistManagers([...managers, newManager]);
          setCurrentManagerId(newManager.id);
          setRole("manager");
        }}
        onResetPassword={resetManagerPassword}
      />
    );
  }

  if (role === "owner") {
    return (
      <OwnerDashboard
        managers={managers}
        partners={partners}
        clients={clients}
        saving={saving}
        onLogout={() => setRole(null)}
        onAddPartner={async (data) =>
          persistPartners([...partners, { id: uid(), rate: PARTNER_RATE, ...data }])
        }
        onTogglePaid={async (clientId) => {
          const next = clients.map((c) =>
            c.id === clientId ? { ...c, paid: !c.paid, paidAt: !c.paid ? new Date().toISOString() : null } : c
          );
          await persistClients(next);
        }}
        onTogglePartnerPaid={toggleClientPartnerPaid}
        onUpdatePartnerRate={updatePartnerRate}
        onUpdatePartnerInfo={updatePartnerInfo}
        onAddClient={async (partnerId, data) => {
          const partner = partners.find((p) => p.id === partnerId);
          return persistClients([...clients, { id: uid(), partnerId, paid: false, paidAt: null, partnerPaidAt: null, rate: partner?.rate ?? PARTNER_RATE, amount: CLIENT_SERVICE_PRICE, note: "", dateAdded: new Date().toISOString().slice(0, 10), ...data }]);
        }}
        paidCountForManager={paidCountForManager}
        paidCountForPartner={paidCountForPartner}
        managerOwed={managerOwed}
        partnerOwed={partnerOwed}
        managerPaidOutTotal={managerPaidOutTotal}
        partnerPaidOutTotal={partnerPaidOutTotal}
        managerClientBreakdown={managerClientBreakdown}
        managerPayouts={managerPayouts}
        onPayoutManager={payoutManager}
        totalRevenue={totalRevenue}
        onUpdateClientAmount={updateClientAmount}
        onUpdateClientNote={updateClientNote}
        onUpdateClientInfo={updateClientInfo}
        selectedPartnerId={selectedPartnerId}
        setSelectedPartnerId={setSelectedPartnerId}
      />
    );
  }

  if (role === "manager") {
    const me = managers.find((m) => m.id === currentManagerId);
    return (
      <ManagerDashboard
        me={me}
        partners={partners.filter((p) => p.managerId === currentManagerId)}
        clients={clients}
        saving={saving}
        onLogout={() => {
          setRole(null);
          setCurrentManagerId(null);
        }}
        onAddPartner={async (data) =>
          persistPartners([...partners, { id: uid(), managerId: currentManagerId, rate: PARTNER_RATE, ...data }])
        }
        onUpdatePartnerInfo={updatePartnerInfo}
        onUpdateClientInfo={updateClientInfo}
        onAddClient={async (partnerId, data) => {
          const partner = partners.find((p) => p.id === partnerId);
          return persistClients([...clients, { id: uid(), partnerId, paid: false, paidAt: null, partnerPaidAt: null, rate: partner?.rate ?? PARTNER_RATE, amount: CLIENT_SERVICE_PRICE, note: "", dateAdded: new Date().toISOString().slice(0, 10), ...data }]);
        }}
        paidCountForManager={paidCountForManager}
        paidCountForPartner={paidCountForPartner}
        managerOwed={managerOwed}
        partnerOwed={partnerOwed}
        managerPaidOutTotal={managerPaidOutTotal}
        partnerPaidOutTotal={partnerPaidOutTotal}
        managerClientBreakdown={managerClientBreakdown}
        managerPayouts={managerPayouts}
        selectedPartnerId={selectedPartnerId}
        setSelectedPartnerId={setSelectedPartnerId}
      />
    );
  }

  if (role === "specialist") {
    const me = specialists.find((s) => s.id === currentSpecialistId);
    return (
      <SpecialistDashboard
        me={me}
        managers={managers}
        partners={partners}
        clients={clients}
        saving={saving}
        onLogout={() => {
          setRole(null);
          setCurrentSpecialistId(null);
        }}
      />
    );
  }

  return null;
}

function RoleScreen({ onOwner, onManager, onSpecialist }) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Building2 className="w-9 h-9 text-teal-700 mx-auto mb-2" />
          <h1 className="text-2xl font-bold text-slate-800">Brocs · Партнёрская сеть</h1>
          <p className="text-slate-500 text-sm mt-1">Учёт партнёр-менеджеров, партнёров и клиентов</p>
        </div>
        <div className="grid grid-cols-1 gap-3">
          <button
            onClick={onOwner}
            className="bg-white border border-slate-200 rounded-2xl p-5 text-left hover:border-teal-600 hover:shadow-sm transition"
          >
            <Shield className="w-6 h-6 text-teal-700 mb-2" />
            <div className="font-semibold text-slate-800">Я — владелец</div>
            <div className="text-sm text-slate-500">Вижу всех менеджеров, партнёров, клиентов. Подтверждаю оплаты.</div>
          </button>
          <button
            onClick={onManager}
            className="bg-white border border-slate-200 rounded-2xl p-5 text-left hover:border-teal-600 hover:shadow-sm transition"
          >
            <Users className="w-6 h-6 text-teal-700 mb-2" />
            <div className="font-semibold text-slate-800">Я — партнёр-менеджер</div>
            <div className="text-sm text-slate-500">Веду своих партнёров и их клиентов.</div>
          </button>
          <button
            onClick={onSpecialist}
            className="bg-white border border-slate-200 rounded-2xl p-5 text-left hover:border-teal-600 hover:shadow-sm transition"
          >
            <BarChart3 className="w-6 h-6 text-teal-700 mb-2" />
            <div className="font-semibold text-slate-800">Я — специалист по аналитике</div>
            <div className="text-sm text-slate-500">Вижу, какой клиент от какого партнёра и менеджера пришёл. Только просмотр.</div>
          </button>
        </div>
      </div>
    </div>
  );
}

function OwnerRecovery({ onBack, onRecovered }) {
  const [code, setCode] = useState("");
  const [newLogin, setNewLogin] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = () => {
    if (code !== OWNER_RECOVERY_CODE) {
      setError("Неверный код восстановления");
      return;
    }
    if (!newLogin || !newPassword) {
      setError("Заполните новый логин и пароль");
      return;
    }
    setError("");
    onRecovered(newLogin, newPassword);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 w-full max-w-sm">
        <button onClick={onBack} className="flex items-center gap-1 text-slate-500 text-sm mb-4 hover:text-slate-700">
          <ChevronLeft className="w-4 h-4" /> Назад
        </button>
        <h2 className="text-lg font-semibold text-slate-800 mb-1">Восстановление доступа владельца</h2>
        <p className="text-sm text-slate-500 mb-4">Код восстановления задан заранее — им может быть только владелец</p>
        <div className="space-y-3">
          <Field label="Код восстановления" type="password" value={code} onChange={setCode} />
          <Field label="Новый логин" value={newLogin} onChange={setNewLogin} />
          <Field label="Новый пароль" type="password" value={newPassword} onChange={setNewPassword} />
        </div>
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
        <button
          onClick={handleSubmit}
          className="w-full mt-4 bg-teal-700 text-white rounded-lg py-2 text-sm font-medium hover:bg-teal-800"
        >
          Сбросить и войти
        </button>
      </div>
    </div>
  );
}

function ManagerLogin({ managers, onBack, onSelect, onRegister, onResetPassword }) {
  const [mode, setMode] = useState(managers.length ? "login" : "register");
  const [form, setForm] = useState({ fullName: "", idNumber: "", city: "", email: "", login: "", password: "" });
  const [loginInput, setLoginInput] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [registerError, setRegisterError] = useState("");
  const [recoverLogin, setRecoverLogin] = useState("");
  const [recoverIdNumber, setRecoverIdNumber] = useState("");
  const [recoverPassword, setRecoverPassword] = useState("");
  const [recoverError, setRecoverError] = useState("");

  const handleLogin = () => {
    const manager = managers.find((m) => m.login === loginInput.trim());
    if (!manager) {
      setLoginError("Такого логина нет");
      return;
    }
    if (loginPassword !== manager.password) {
      setLoginError("Неверный пароль");
      return;
    }
    setLoginError("");
    onSelect(manager.id);
  };

  const handleRegister = () => {
    if (managers.some((m) => m.login === form.login.trim())) {
      setRegisterError("Такой логин уже занят, придумайте другой");
      return;
    }
    setRegisterError("");
    onRegister({ ...form, login: form.login.trim() });
  };

  const handleRecover = () => {
    const manager = managers.find((m) => m.login === recoverLogin.trim() && m.idNumber === recoverIdNumber.trim());
    if (!manager) {
      setRecoverError("Логин и ИИН не совпадают ни с одним профилем");
      return;
    }
    if (!recoverPassword) {
      setRecoverError("Введите новый пароль");
      return;
    }
    setRecoverError("");
    onResetPassword(manager.id, recoverPassword);
    onSelect(manager.id);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 w-full max-w-md">
        <button onClick={onBack} className="flex items-center gap-1 text-slate-500 text-sm mb-4 hover:text-slate-700">
          <ChevronLeft className="w-4 h-4" /> Назад
        </button>

        {mode !== "recover" && (
          <div className="flex gap-2 mb-5 bg-slate-100 rounded-lg p-1">
            <button
              onClick={() => setMode("login")}
              className={`flex-1 text-sm font-medium rounded-md py-1.5 ${mode === "login" ? "bg-white shadow-sm text-slate-800" : "text-slate-500"}`}
            >
              Войти
            </button>
            <button
              onClick={() => setMode("register")}
              className={`flex-1 text-sm font-medium rounded-md py-1.5 ${mode === "register" ? "bg-white shadow-sm text-slate-800" : "text-slate-500"}`}
            >
              Зарегистрироваться
            </button>
          </div>
        )}

        {mode === "login" && (
          <>
            <h2 className="text-lg font-semibold text-slate-800 mb-3">Вход в профиль</h2>
            <div className="space-y-3">
              <Field label="Логин" value={loginInput} onChange={setLoginInput} />
              <Field label="Пароль" type="password" value={loginPassword} onChange={setLoginPassword} />
            </div>
            {loginError && <p className="text-sm text-red-600 mt-2">{loginError}</p>}
            <button
              onClick={handleLogin}
              className="w-full mt-4 bg-teal-700 text-white rounded-lg py-2 text-sm font-medium hover:bg-teal-800"
            >
              Войти
            </button>
            <button onClick={() => setMode("recover")} className="w-full text-center text-teal-700 text-sm font-medium mt-3 hover:underline">
              Забыли пароль?
            </button>
          </>
        )}

        {mode === "register" && (
          <>
            <h2 className="text-lg font-semibold text-slate-800 mb-3">Регистрация партнёр-менеджера</h2>
            <div className="space-y-3">
              <Field label="ФИО" value={form.fullName} onChange={(v) => setForm({ ...form, fullName: v })} />
              <Field label="ИИН" value={form.idNumber} onChange={(v) => setForm({ ...form, idNumber: v })} />
              <Field label="Город" value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
              <Field label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
              <Field label="Придумайте логин" value={form.login} onChange={(v) => setForm({ ...form, login: v })} />
              <Field label="Придумайте пароль" type="password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} />
            </div>
            {registerError && <p className="text-sm text-red-600 mt-2">{registerError}</p>}
            <button
              disabled={!form.fullName || !form.idNumber || !form.city || !form.email || !form.login || !form.password}
              onClick={handleRegister}
              className="w-full mt-4 bg-teal-700 text-white rounded-lg py-2 text-sm font-medium hover:bg-teal-800 disabled:opacity-40"
            >
              Зарегистрироваться и войти
            </button>
          </>
        )}

        {mode === "recover" && (
          <>
            <h2 className="text-lg font-semibold text-slate-800 mb-3">Восстановление пароля</h2>
            <p className="text-sm text-slate-500 mb-3">Подтвердите логин и ИИН, указанные при регистрации</p>
            <div className="space-y-3">
              <Field label="Логин" value={recoverLogin} onChange={setRecoverLogin} />
              <Field label="ИИН" value={recoverIdNumber} onChange={setRecoverIdNumber} />
              <Field label="Новый пароль" type="password" value={recoverPassword} onChange={setRecoverPassword} />
            </div>
            {recoverError && <p className="text-sm text-red-600 mt-2">{recoverError}</p>}
            <button
              onClick={handleRecover}
              className="w-full mt-4 bg-teal-700 text-white rounded-lg py-2 text-sm font-medium hover:bg-teal-800"
            >
              Сбросить и войти
            </button>
            <button onClick={() => setMode("login")} className="w-full text-center text-slate-500 text-sm mt-3 hover:underline">
              Вспомнил пароль — назад ко входу
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SpecialistLogin({ specialists, onBack, onSelect, onRegister, onResetPassword }) {
  const [mode, setMode] = useState(specialists.length ? "login" : "register");
  const [form, setForm] = useState({ fullName: "", login: "", password: "" });
  const [loginInput, setLoginInput] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [registerError, setRegisterError] = useState("");
  const [recoverLogin, setRecoverLogin] = useState("");
  const [recoverFullName, setRecoverFullName] = useState("");
  const [recoverPassword, setRecoverPassword] = useState("");
  const [recoverError, setRecoverError] = useState("");

  const handleLogin = () => {
    const specialist = specialists.find((s) => s.login === loginInput.trim());
    if (!specialist) {
      setLoginError("Такого логина нет");
      return;
    }
    if (loginPassword !== specialist.password) {
      setLoginError("Неверный пароль");
      return;
    }
    setLoginError("");
    onSelect(specialist.id);
  };

  const handleRegister = () => {
    if (specialists.some((s) => s.login === form.login.trim())) {
      setRegisterError("Такой логин уже занят, придумайте другой");
      return;
    }
    setRegisterError("");
    onRegister({ ...form, login: form.login.trim() });
  };

  const handleRecover = () => {
    const specialist = specialists.find(
      (s) => s.login === recoverLogin.trim() && s.fullName.trim().toLowerCase() === recoverFullName.trim().toLowerCase()
    );
    if (!specialist) {
      setRecoverError("Логин и ФИО не совпадают ни с одним профилем");
      return;
    }
    if (!recoverPassword) {
      setRecoverError("Введите новый пароль");
      return;
    }
    setRecoverError("");
    onResetPassword(specialist.id, recoverPassword);
    onSelect(specialist.id);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 w-full max-w-md">
        <button onClick={onBack} className="flex items-center gap-1 text-slate-500 text-sm mb-4 hover:text-slate-700">
          <ChevronLeft className="w-4 h-4" /> Назад
        </button>

        {mode !== "recover" && (
          <div className="flex gap-2 mb-5 bg-slate-100 rounded-lg p-1">
            <button
              onClick={() => setMode("login")}
              className={`flex-1 text-sm font-medium rounded-md py-1.5 ${mode === "login" ? "bg-white shadow-sm text-slate-800" : "text-slate-500"}`}
            >
              Войти
            </button>
            <button
              onClick={() => setMode("register")}
              className={`flex-1 text-sm font-medium rounded-md py-1.5 ${mode === "register" ? "bg-white shadow-sm text-slate-800" : "text-slate-500"}`}
            >
              Зарегистрироваться
            </button>
          </div>
        )}

        {mode === "login" && (
          <>
            <h2 className="text-lg font-semibold text-slate-800 mb-3">Вход в профиль</h2>
            <div className="space-y-3">
              <Field label="Логин" value={loginInput} onChange={setLoginInput} />
              <Field label="Пароль" type="password" value={loginPassword} onChange={setLoginPassword} />
            </div>
            {loginError && <p className="text-sm text-red-600 mt-2">{loginError}</p>}
            <button
              onClick={handleLogin}
              className="w-full mt-4 bg-teal-700 text-white rounded-lg py-2 text-sm font-medium hover:bg-teal-800"
            >
              Войти
            </button>
            <button onClick={() => setMode("recover")} className="w-full text-center text-teal-700 text-sm font-medium mt-3 hover:underline">
              Забыли пароль?
            </button>
          </>
        )}

        {mode === "register" && (
          <>
            <h2 className="text-lg font-semibold text-slate-800 mb-3">Регистрация специалиста по аналитике</h2>
            <div className="space-y-3">
              <Field label="ФИО" value={form.fullName} onChange={(v) => setForm({ ...form, fullName: v })} />
              <Field label="Придумайте логин" value={form.login} onChange={(v) => setForm({ ...form, login: v })} />
              <Field label="Придумайте пароль" type="password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} />
            </div>
            {registerError && <p className="text-sm text-red-600 mt-2">{registerError}</p>}
            <button
              disabled={!form.fullName || !form.login || !form.password}
              onClick={handleRegister}
              className="w-full mt-4 bg-teal-700 text-white rounded-lg py-2 text-sm font-medium hover:bg-teal-800 disabled:opacity-40"
            >
              Зарегистрироваться и войти
            </button>
          </>
        )}

        {mode === "recover" && (
          <>
            <h2 className="text-lg font-semibold text-slate-800 mb-3">Восстановление пароля</h2>
            <p className="text-sm text-slate-500 mb-3">Подтвердите логин и ФИО, указанные при регистрации</p>
            <div className="space-y-3">
              <Field label="Логин" value={recoverLogin} onChange={setRecoverLogin} />
              <Field label="ФИО" value={recoverFullName} onChange={setRecoverFullName} />
              <Field label="Новый пароль" type="password" value={recoverPassword} onChange={setRecoverPassword} />
            </div>
            {recoverError && <p className="text-sm text-red-600 mt-2">{recoverError}</p>}
            <button
              onClick={handleRecover}
              className="w-full mt-4 bg-teal-700 text-white rounded-lg py-2 text-sm font-medium hover:bg-teal-800"
            >
              Сбросить и войти
            </button>
            <button onClick={() => setMode("login")} className="w-full text-center text-slate-500 text-sm mt-3 hover:underline">
              Вспомнил пароль — назад ко входу
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
      />
    </label>
  );
}

function TopBar({ title, subtitle, onLogout, saving }) {
  return (
    <div className="bg-white border-b border-slate-200 px-5 py-4 flex items-center justify-between sticky top-0 z-10">
      <div>
        <div className="font-semibold text-slate-800">{title}</div>
        {subtitle && <div className="text-xs text-slate-500">{subtitle}</div>}
      </div>
      <div className="flex items-center gap-3">
        {saving && <span className="text-xs text-slate-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin"/>сохранение</span>}
        <button onClick={onLogout} className="text-sm text-slate-500 hover:text-slate-800">Выйти</button>
      </div>
    </div>
  );
}

function AddPartnerForm({ onAdd, onClose }) {
  const [form, setForm] = useState({ name: "", city: "", niche: "", phone: "" });
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="font-medium text-slate-800 text-sm">Новый партнёр</div>
        <button onClick={onClose}><X className="w-4 h-4 text-slate-400" /></button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Имя" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
        <Field label="Город" value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
        <Field label="Сфера бизнеса" value={form.niche} onChange={(v) => setForm({ ...form, niche: v })} />
        <Field label="Телефон" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
      </div>
      <button
        disabled={!form.name || !form.phone}
        onClick={() => { onAdd(form); onClose(); }}
        className="mt-3 bg-teal-700 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-teal-800 disabled:opacity-40"
      >
        Добавить партнёра
      </button>
    </div>
  );
}

function AddClientForm({ onAdd, onClose }) {
  const [form, setForm] = useState({ name: "", phone: "" });
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-3">
      <div className="flex items-center justify-between mb-3">
        <div className="font-medium text-slate-800 text-sm">Новый клиент</div>
        <button onClick={onClose}><X className="w-4 h-4 text-slate-400" /></button>
      </div>
      <div className="space-y-3">
        <Field label="Имя клиента" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
        <Field label="Номер телефона" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
      </div>
      <button
        disabled={!form.name || !form.phone}
        onClick={() => { onAdd(form); onClose(); }}
        className="mt-3 bg-teal-700 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-teal-800 disabled:opacity-40"
      >
        Добавить клиента
      </button>
    </div>
  );
}

function ClientAmountBadge({ client, onUpdateAmount }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(client.amount ?? CLIENT_SERVICE_PRICE));
  if (editing) {
    return (
      <div className="flex items-center gap-1 mt-0.5">
        <input
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-20 border border-slate-300 rounded px-1 py-0.5 text-xs text-right focus:outline-none focus:ring-1 focus:ring-teal-600"
        />
        <button
          onClick={() => {
            const n = Number(value);
            if (n > 0) onUpdateAmount(client.id, n);
            setEditing(false);
          }}
          className="text-teal-700 text-xs font-medium hover:underline"
        >
          ✓
        </button>
      </div>
    );
  }
  return (
    <button onClick={() => setEditing(true)} className="text-xs text-slate-400 hover:text-teal-700 mt-0.5">
      Оплата клиента: {money(client.amount ?? CLIENT_SERVICE_PRICE)} <span className="underline">изменить</span>
    </button>
  );
}

function ClientNoteBadge({ client, isOwner, onUpdateNote }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(client.note || "");

  if (editing) {
    return (
      <div className="flex items-start gap-1 mt-1">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Например: клиент отложил оплату на неделю"
          className="flex-1 border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-600"
        />
        <button
          onClick={() => {
            onUpdateNote(client.id, value.trim());
            setEditing(false);
          }}
          className="text-teal-700 text-xs font-medium hover:underline shrink-0 mt-1"
        >
          ✓
        </button>
      </div>
    );
  }

  if (isOwner) {
    return (
      <button onClick={() => setEditing(true)} className="text-xs text-left mt-1 block">
        {client.note ? (
          <span className="text-amber-700">📝 {client.note} <span className="text-slate-400 underline">изменить</span></span>
        ) : (
          <span className="text-slate-400 hover:text-teal-700 underline">Добавить примечание</span>
        )}
      </button>
    );
  }

  return client.note ? <div className="text-xs text-amber-700 mt-1">📝 {client.note}</div> : null;
}

function ClientInfoEdit({ client, onUpdateInfo }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(client.name);
  const [phone, setPhone] = useState(client.phone || "");

  if (editing) {
    return (
      <div className="space-y-1 mb-1">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Имя клиента"
          className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-teal-600"
        />
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Телефон"
            className="flex-1 border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-600"
          />
          <button
            onClick={() => {
              if (name.trim()) onUpdateInfo(client.id, { name: name.trim(), phone: phone.trim() });
              setEditing(false);
            }}
            className="text-teal-700 text-xs font-medium hover:underline shrink-0"
          >
            Сохранить
          </button>
        </div>
      </div>
    );
  }

  return (
    <button onClick={() => setEditing(true)} className="text-left hover:opacity-70">
      <div className="text-sm text-slate-700">{client.name}</div>
      {client.phone && <div className="text-xs text-slate-400">{client.phone}</div>}
    </button>
  );
}

function PartnerCard({ partner, clientsList, paidCount, earned, paidOut, owed, isOwner, onTogglePaid, onTogglePartnerPaid, onUpdatePartnerRate, onUpdatePartnerInfo, onUpdateClientAmount, onUpdateClientNote, onUpdateClientInfo, onAddClient, expanded, onToggleExpand }) {
  const [showAddClient, setShowAddClient] = useState(false);
  const [editingRate, setEditingRate] = useState(false);
  const [rateInput, setRateInput] = useState(String(partner.rate ?? PARTNER_RATE));
  const [editingPartnerInfo, setEditingPartnerInfo] = useState(false);
  const [partnerForm, setPartnerForm] = useState({ name: partner.name, city: partner.city, niche: partner.niche, phone: partner.phone });
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("ru-RU") : "");
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <button onClick={onToggleExpand} className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50">
        <div className="text-left">
          <div className="font-medium text-slate-800">{partner.name}</div>
          <div className="text-xs text-slate-500">{partner.city} · {partner.niche} · {partner.phone}</div>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold text-teal-700">{money(owed)}</div>
          <div className="text-xs text-slate-400">{paidCount} оплаченных всего · {clientsList.length} клиентов</div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-slate-100 px-4 py-3">
          {onUpdatePartnerInfo && (
            <div className="mb-3 bg-slate-50 rounded-lg px-3 py-2">
              {editingPartnerInfo ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Имя" value={partnerForm.name} onChange={(v) => setPartnerForm({ ...partnerForm, name: v })} />
                    <Field label="Город" value={partnerForm.city} onChange={(v) => setPartnerForm({ ...partnerForm, city: v })} />
                    <Field label="Сфера бизнеса" value={partnerForm.niche} onChange={(v) => setPartnerForm({ ...partnerForm, niche: v })} />
                    <Field label="Телефон" value={partnerForm.phone} onChange={(v) => setPartnerForm({ ...partnerForm, phone: v })} />
                  </div>
                  <button
                    onClick={() => {
                      if (partnerForm.name.trim()) onUpdatePartnerInfo(partner.id, partnerForm);
                      setEditingPartnerInfo(false);
                    }}
                    className="text-teal-700 text-sm font-medium hover:underline"
                  >
                    Сохранить
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">Данные партнёра</span>
                  <button onClick={() => { setPartnerForm({ name: partner.name, city: partner.city, niche: partner.niche, phone: partner.phone }); setEditingPartnerInfo(true); }} className="text-teal-700 text-xs font-medium hover:underline">
                    Изменить
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between mb-3 bg-slate-50 rounded-lg px-3 py-2">
            <span className="text-xs text-slate-500">Ставка за нового клиента</span>
            {editingRate ? (
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={rateInput}
                  onChange={(e) => setRateInput(e.target.value)}
                  className="w-24 border border-slate-300 rounded-lg px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
                <button
                  onClick={() => {
                    const n = Number(rateInput);
                    if (n > 0) onUpdatePartnerRate(partner.id, n);
                    setEditingRate(false);
                  }}
                  className="text-teal-700 text-sm font-medium hover:underline"
                >
                  Сохранить
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-800">{money(partner.rate ?? PARTNER_RATE)}</span>
                {isOwner && (
                  <button onClick={() => { setRateInput(String(partner.rate ?? PARTNER_RATE)); setEditingRate(true); }} className="text-teal-700 text-xs font-medium hover:underline">
                    Изменить
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="bg-slate-50 rounded-lg p-2 text-center">
              <div className="text-xs text-slate-400">Заработано</div>
              <div className="text-sm font-semibold text-slate-800">{money(earned)}</div>
            </div>
            <div className="bg-slate-50 rounded-lg p-2 text-center">
              <div className="text-xs text-slate-400">Выплачено</div>
              <div className="text-sm font-semibold text-slate-800">{money(paidOut)}</div>
            </div>
            <div className="bg-slate-50 rounded-lg p-2 text-center">
              <div className="text-xs text-slate-400">К выплате</div>
              <div className="text-sm font-semibold text-teal-700">{money(owed)}</div>
            </div>
          </div>

          {clientsList.length === 0 && <div className="text-sm text-slate-400 mb-2">Клиентов пока нет</div>}
          <div className="space-y-1 mb-3">
            {clientsList.map((c) => (
              <div key={c.id} className="py-2 border-b border-slate-50 last:border-0">
                <div className="flex items-center justify-between">
                  <div>
                    {onUpdateClientInfo ? (
                      <ClientInfoEdit client={c} onUpdateInfo={onUpdateClientInfo} />
                    ) : (
                      <>
                        <div className="text-sm text-slate-700">{c.name}</div>
                        {c.phone && <div className="text-xs text-slate-400">{c.phone}</div>}
                      </>
                    )}
                    {isOwner && onUpdateClientAmount && (
                      <ClientAmountBadge client={c} onUpdateAmount={onUpdateClientAmount} />
                    )}
                  </div>
                  <button
                    disabled={!isOwner}
                    onClick={() => isOwner && onTogglePaid(c.id)}
                    className={`flex items-center gap-1 text-xs font-medium ${c.paid ? "text-emerald-600" : "text-slate-400"} ${isOwner ? "cursor-pointer" : "cursor-default"}`}
                  >
                    {c.paid ? <CheckCircle2 className="w-4 h-4" /> : <Circle className="w-4 h-4" />}
                    {c.paid ? "Клиент оплатил" : "Ожидает оплаты"}
                  </button>
                </div>
                {c.paid && (
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-slate-400">{money(c.rate ?? PARTNER_RATE)} партнёру{c.partnerPaidAt ? ` · выплачено ${fmtDate(c.partnerPaidAt)}` : ""}</span>
                    <button
                      disabled={!isOwner}
                      onClick={() => isOwner && onTogglePartnerPaid(c.id)}
                      className={`flex items-center gap-1 text-xs font-medium ${c.partnerPaidAt ? "text-emerald-600" : "text-amber-600"} ${isOwner ? "cursor-pointer" : "cursor-default"}`}
                    >
                      {c.partnerPaidAt ? <CheckCircle2 className="w-4 h-4" /> : <Circle className="w-4 h-4" />}
                      {c.partnerPaidAt ? "Партнёру выплачено" : "Выплатить партнёру"}
                    </button>
                  </div>
                )}
                <ClientNoteBadge client={c} isOwner={isOwner && !!onUpdateClientNote} onUpdateNote={onUpdateClientNote} />
              </div>
            ))}
          </div>
          {showAddClient ? (
            <AddClientForm onAdd={(data) => onAddClient(partner.id, data)} onClose={() => setShowAddClient(false)} />
          ) : (
            <button onClick={() => setShowAddClient(true)} className="text-teal-700 text-sm font-medium flex items-center gap-1 hover:underline">
              <Plus className="w-4 h-4" /> Добавить клиента
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PartnersList({ partners, clients, isOwner, onTogglePaid, onTogglePartnerPaid, onUpdatePartnerRate, onUpdatePartnerInfo, onUpdateClientAmount, onUpdateClientNote, onUpdateClientInfo, onAddClient, paidCountForPartner, partnerOwed, partnerPaidOutTotal, selectedPartnerId, setSelectedPartnerId }) {
  return (
    <div className="space-y-2">
      {partners.map((p) => {
        const paidCount = paidCountForPartner(p.id);
        const paidOut = partnerPaidOutTotal(p.id);
        const owed = partnerOwed(p.id);
        return (
          <PartnerCard
            key={p.id}
            partner={p}
            clientsList={clients.filter((c) => c.partnerId === p.id)}
            paidCount={paidCount}
            earned={paidOut + owed}
            paidOut={paidOut}
            owed={owed}
            isOwner={isOwner}
            onTogglePaid={onTogglePaid}
            onTogglePartnerPaid={onTogglePartnerPaid}
            onUpdatePartnerRate={onUpdatePartnerRate}
            onUpdatePartnerInfo={onUpdatePartnerInfo}
            onUpdateClientAmount={onUpdateClientAmount}
            onUpdateClientNote={onUpdateClientNote}
            onUpdateClientInfo={onUpdateClientInfo}
            onAddClient={onAddClient}
            expanded={selectedPartnerId === p.id}
            onToggleExpand={() => setSelectedPartnerId(selectedPartnerId === p.id ? null : p.id)}
          />
        );
      })}
    </div>
  );
}

function TabNav({ tabs, active, onChange }) {
  return (
    <div className="flex gap-1 bg-slate-100 rounded-lg p-1 mb-5">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`flex-1 flex items-center justify-center gap-1.5 text-sm font-medium rounded-md py-2 ${active === t.key ? "bg-white shadow-sm text-slate-800" : "text-slate-500"}`}
        >
          <t.icon className="w-4 h-4" /> {t.label}
        </button>
      ))}
    </div>
  );
}

function EarningsAnalytics({ title, rows, filterLabel }) {
  const [nameFilter, setNameFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = rows.filter((r) => {
    if (nameFilter !== "all" && r.id !== nameFilter) return false;
    if (statusFilter === "owed" && r.owed <= 0) return false;
    if (statusFilter === "settled" && r.owed > 0) return false;
    return true;
  });

  const totalEarned = filtered.reduce((s, r) => s + r.earned, 0);
  const totalPaidOut = filtered.reduce((s, r) => s + r.paidOut, 0);
  const totalOwed = filtered.reduce((s, r) => s + r.owed, 0);
  const chartData = filtered.map((r) => ({ name: r.name.length > 10 ? r.name.slice(0, 10) + "…" : r.name, "К выплате": r.owed }));

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Filter className="w-4 h-4 text-slate-400" />
        <h3 className="font-semibold text-slate-800 text-sm">{title}</h3>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <select
          value={nameFilter}
          onChange={(e) => setNameFilter(e.target.value)}
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
        >
          <option value="all">{filterLabel}: все</option>
          {rows.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
        >
          <option value="all">Статус: все</option>
          <option value="owed">Есть к выплате</option>
          <option value="settled">Полностью выплачено</option>
        </select>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="bg-slate-50 rounded-lg p-2 text-center">
          <div className="text-xs text-slate-400">Заработано</div>
          <div className="text-sm font-semibold text-slate-800">{money(totalEarned)}</div>
        </div>
        <div className="bg-slate-50 rounded-lg p-2 text-center">
          <div className="text-xs text-slate-400">Выплачено</div>
          <div className="text-sm font-semibold text-slate-800">{money(totalPaidOut)}</div>
        </div>
        <div className="bg-slate-50 rounded-lg p-2 text-center">
          <div className="text-xs text-slate-400">К выплате</div>
          <div className="text-sm font-semibold text-teal-700">{money(totalOwed)}</div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-sm text-slate-400 text-center py-6">Нет данных под текущий фильтр</div>
      ) : (
        <>
          <div className="h-52 mb-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => money(v)} />
                <Bar dataKey="К выплате" fill="#0f766e" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="space-y-1">
            {filtered.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-sm py-1.5 border-b border-slate-50 last:border-0">
                <div>
                  <div className="text-slate-700">{r.name}</div>
                  {r.sub && <div className="text-xs text-slate-400">{r.sub}</div>}
                </div>
                <div className="text-right">
                  <div className="font-medium text-slate-800">{money(r.owed)}</div>
                  <div className="text-xs text-slate-400">заработано {money(r.earned)}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ExportPanel({ managers, partners, clients, paidCountForManager, managerOwed, managerPaidOutTotal, paidCountForPartner, partnerOwed, partnerPaidOutTotal }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [managerFilter, setManagerFilter] = useState("all");
  const [partnerFilter, setPartnerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const managerIdByPartnerId = Object.fromEntries(partners.map((p) => [p.id, p.managerId]));
  const managerNameById = Object.fromEntries(managers.map((m) => [m.id, m.fullName]));
  const partnerNameById = Object.fromEntries(partners.map((p) => [p.id, p.name]));
  const partnerOptions = managerFilter === "all" ? partners : partners.filter((p) => p.managerId === managerFilter);

  const filteredClients = clients.filter((c) => {
    if (dateFrom && (!c.dateAdded || c.dateAdded < dateFrom)) return false;
    if (dateTo && (!c.dateAdded || c.dateAdded > dateTo)) return false;
    if (managerFilter !== "all" && managerIdByPartnerId[c.partnerId] !== managerFilter) return false;
    if (partnerFilter !== "all" && c.partnerId !== partnerFilter) return false;
    if (statusFilter === "paid" && !c.paid) return false;
    if (statusFilter === "unpaid" && c.paid) return false;
    return true;
  });

  const handleDownload = () => {
    const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("ru-RU") : "");

    const clientsSheet = filteredClients.map((c) => ({
      "Клиент": c.name,
      "Телефон": c.phone || "",
      "Партнёр": partnerNameById[c.partnerId] || "",
      "Менеджер": managerNameById[managerIdByPartnerId[c.partnerId]] || "",
      "Дата добавления": c.dateAdded || "",
      "Оплатил": c.paid ? "Да" : "Нет",
      "Дата оплаты": fmtDate(c.paidAt),
      "Оплата клиента, тг": c.amount ?? CLIENT_SERVICE_PRICE,
      "Ставка партнёру, тг": c.rate ?? PARTNER_RATE,
      "Партнёру выплачено": c.partnerPaidAt ? "Да" : "Нет",
      "Дата выплаты партнёру": fmtDate(c.partnerPaidAt),
      "Примечание": c.note || "",
    }));

    const relevantPartnerIds = new Set(filteredClients.map((c) => c.partnerId));
    let partnersToExport = partners.filter((p) => relevantPartnerIds.has(p.id));
    if (partnerFilter !== "all") partnersToExport = partners.filter((p) => p.id === partnerFilter);
    else if (managerFilter !== "all") partnersToExport = partners.filter((p) => p.managerId === managerFilter);

    const partnersSheet = partnersToExport.map((p) => {
      const paidOut = partnerPaidOutTotal(p.id);
      const owed = partnerOwed(p.id);
      return {
        "Партнёр": p.name,
        "Город": p.city,
        "Сфера бизнеса": p.niche,
        "Телефон": p.phone,
        "Менеджер": managerNameById[p.managerId] || "",
        "Ставка, тг/клиент": p.rate ?? PARTNER_RATE,
        "Оплаченных клиентов всего": paidCountForPartner(p.id),
        "Заработано, тг": paidOut + owed,
        "Выплачено, тг": paidOut,
        "К выплате, тг": owed,
      };
    });

    const managersToExport = managerFilter === "all" ? managers : managers.filter((m) => m.id === managerFilter);
    const managersSheet = managersToExport.map((m) => {
      const paidOut = managerPaidOutTotal(m.id);
      const owed = managerOwed(m.id);
      return {
        "Менеджер": m.fullName,
        "Город": m.city,
        "ИИН": m.idNumber,
        "Email": m.email,
        "Логин": m.login,
        "Дата начала работы": m.startDate,
        "Оплаченных клиентов всего": paidCountForManager(m.id),
        "Заработано, тг": paidOut + owed,
        "Выплачено, тг": paidOut,
        "К выплате, тг": owed,
      };
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(managersSheet), "Менеджеры");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(partnersSheet), "Партнёры");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(clientsSheet), "Клиенты");

    const rangeLabel = dateFrom || dateTo ? `${dateFrom || "начало"}_${dateTo || "сегодня"}` : "все-даты";
    XLSX.writeFile(wb, `Brocs_отчёт_${rangeLabel}.xlsx`);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Filter className="w-4 h-4 text-slate-400" />
        <h3 className="font-semibold text-slate-800 text-sm">Фильтры выгрузки</h3>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-2">
        <label className="block">
          <span className="text-xs font-medium text-slate-500">Дата с</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-500">Дата по</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-2 mb-4">
        <select
          value={managerFilter}
          onChange={(e) => { setManagerFilter(e.target.value); setPartnerFilter("all"); }}
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
        >
          <option value="all">Менеджер: все</option>
          {managers.map((m) => (
            <option key={m.id} value={m.id}>{m.fullName}</option>
          ))}
        </select>
        <select
          value={partnerFilter}
          onChange={(e) => setPartnerFilter(e.target.value)}
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
        >
          <option value="all">Партнёр: все</option>
          {partnerOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
        >
          <option value="all">Статус клиента: все</option>
          <option value="paid">Оплатившие</option>
          <option value="unpaid">Ожидают оплаты</option>
        </select>
      </div>

      <div className="bg-slate-50 rounded-lg p-3 mb-4 text-sm text-slate-600">
        Под текущим фильтром: <span className="font-semibold text-slate-800">{filteredClients.length}</span> клиентов попадёт в выгрузку.
      </div>

      <button
        onClick={handleDownload}
        disabled={filteredClients.length === 0}
        className="w-full flex items-center justify-center gap-2 bg-teal-700 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-teal-800 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Download className="w-4 h-4" /> Скачать Excel
      </button>
      <p className="text-xs text-slate-400 mt-2">Файл будет содержать три листа: «Менеджеры», «Партнёры», «Клиенты» — с учётом выбранных дат и фильтров.</p>
    </div>
  );
}

function SpecialistDashboard({ me, managers, partners, clients, saving, onLogout }) {
  const [managerFilter, setManagerFilter] = useState("all");
  const [partnerFilter, setPartnerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const managerNameById = Object.fromEntries(managers.map((m) => [m.id, m.fullName]));
  const partnerNameById = Object.fromEntries(partners.map((p) => [p.id, p.name]));
  const managerIdByPartnerId = Object.fromEntries(partners.map((p) => [p.id, p.managerId]));

  const partnerOptions = managerFilter === "all" ? partners : partners.filter((p) => p.managerId === managerFilter);

  const rows = clients
    .map((c) => ({
      ...c,
      partnerName: partnerNameById[c.partnerId] || "—",
      managerId: managerIdByPartnerId[c.partnerId],
      managerName: managerNameById[managerIdByPartnerId[c.partnerId]] || "—",
    }))
    .filter((c) => {
      if (managerFilter !== "all" && c.managerId !== managerFilter) return false;
      if (partnerFilter !== "all" && c.partnerId !== partnerFilter) return false;
      if (statusFilter === "paid" && !c.paid) return false;
      if (statusFilter === "unpaid" && c.paid) return false;
      return true;
    })
    .sort((a, b) => new Date(b.dateAdded || 0) - new Date(a.dateAdded || 0));

  const countByManager = {};
  const countByPartner = {};
  rows.forEach((c) => {
    countByManager[c.managerName] = (countByManager[c.managerName] || 0) + 1;
    countByPartner[c.partnerName] = (countByPartner[c.partnerName] || 0) + 1;
  });
  const managerChartData = Object.entries(countByManager).map(([name, count]) => ({
    name: name.length > 10 ? name.slice(0, 10) + "…" : name,
    "Клиентов": count,
  }));
  const partnerChartData = Object.entries(countByPartner).map(([name, count]) => ({
    name: name.length > 10 ? name.slice(0, 10) + "…" : name,
    "Клиентов": count,
  }));

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <TopBar title={me ? me.fullName : "Аналитика контактов"} subtitle={`${rows.length} клиентов под текущим фильтром`} onLogout={onLogout} saving={saving} />
      <div className="max-w-2xl mx-auto p-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-4 h-4 text-slate-400" />
            <h3 className="font-semibold text-slate-800 text-sm">Фильтры</h3>
          </div>
          <div className="grid grid-cols-1 gap-2">
            <select
              value={managerFilter}
              onChange={(e) => { setManagerFilter(e.target.value); setPartnerFilter("all"); }}
              className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
            >
              <option value="all">Менеджер: все</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>{m.fullName}</option>
              ))}
            </select>
            <select
              value={partnerFilter}
              onChange={(e) => setPartnerFilter(e.target.value)}
              className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
            >
              <option value="all">Партнёр: все</option>
              {partnerOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
            >
              <option value="all">Статус: все</option>
              <option value="paid">Оплатившие</option>
              <option value="unpaid">Ожидают оплаты</option>
            </select>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
          <div className="text-xs font-medium text-slate-500 mb-2">Клиентов по менеджерам</div>
          {managerChartData.length === 0 ? (
            <div className="text-sm text-slate-400 text-center py-4">Нет данных</div>
          ) : (
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={managerChartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="Клиентов" fill="#0f766e" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
          <div className="text-xs font-medium text-slate-500 mb-2">Клиентов по партнёрам</div>
          {partnerChartData.length === 0 ? (
            <div className="text-sm text-slate-400 text-center py-4">Нет данных</div>
          ) : (
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={partnerChartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="Клиентов" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500 mb-2">Список клиентов</div>
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 text-center py-6">Нет клиентов под текущим фильтром</div>
          ) : (
            <div className="space-y-1">
              {rows.map((c) => (
                <div key={c.id} className="py-2 border-b border-slate-50 last:border-0">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-700">{c.name}</span>
                    <span className={`text-xs font-medium ${c.paid ? "text-emerald-600" : "text-slate-400"}`}>
                      {c.paid ? "Оплатил" : "Ожидает"}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400">
                    Партнёр: {c.partnerName} · Менеджер: {c.managerName} {c.dateAdded ? `· ${c.dateAdded}` : ""}
                  </div>
                  {c.note && <div className="text-xs text-amber-700 mt-0.5">📝 {c.note}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ManagerAddPanel({ partners, onAddPartner, onAddClient }) {
  const [openPartner, setOpenPartner] = useState(false);
  const [openClient, setOpenClient] = useState(false);
  const [clientPartnerId, setClientPartnerId] = useState(partners[0]?.id || "");

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-slate-800 text-sm">Добавить партнёра</h3>
          <button onClick={() => setOpenPartner(!openPartner)} className="text-teal-700 text-sm font-medium hover:underline">
            {openPartner ? "Скрыть" : "Открыть"}
          </button>
        </div>
        {openPartner && <AddPartnerForm onAdd={(data) => { onAddPartner(data); setOpenPartner(false); }} onClose={() => setOpenPartner(false)} />}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-slate-800 text-sm">Добавить клиента</h3>
          <button onClick={() => setOpenClient(!openClient)} className="text-teal-700 text-sm font-medium hover:underline">
            {openClient ? "Скрыть" : "Открыть"}
          </button>
        </div>
        {openClient && (
          partners.length === 0 ? (
            <div className="text-sm text-slate-400">Сначала добавьте партнёра</div>
          ) : (
            <>
              <label className="block mb-3">
                <span className="text-xs font-medium text-slate-500">Партнёр</span>
                <select
                  value={clientPartnerId}
                  onChange={(e) => setClientPartnerId(e.target.value)}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
                >
                  {partners.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} · {p.city}</option>
                  ))}
                </select>
              </label>
              <AddClientForm onAdd={(data) => { onAddClient(clientPartnerId, data); setOpenClient(false); }} onClose={() => setOpenClient(false)} />
            </>
          )
        )}
      </div>
    </div>
  );
}

function OwnerAddPanel({ managers, partners, onAddPartner, onAddClient }) {
  const [openPartner, setOpenPartner] = useState(false);
  const [openClient, setOpenClient] = useState(false);
  const [partnerManagerId, setPartnerManagerId] = useState(managers[0]?.id || "");
  const [clientManagerId, setClientManagerId] = useState(managers[0]?.id || "");
  const [clientPartnerId, setClientPartnerId] = useState("");

  const clientPartnerOptions = partners.filter((p) => p.managerId === clientManagerId);

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-slate-800 text-sm">Добавить партнёра</h3>
          <button onClick={() => setOpenPartner(!openPartner)} className="text-teal-700 text-sm font-medium hover:underline">
            {openPartner ? "Скрыть" : "Открыть"}
          </button>
        </div>
        {openPartner && (
          managers.length === 0 ? (
            <div className="text-sm text-slate-400">Сначала должен зарегистрироваться менеджер</div>
          ) : (
            <>
              <label className="block mb-3">
                <span className="text-xs font-medium text-slate-500">Партнёр-менеджер</span>
                <select
                  value={partnerManagerId}
                  onChange={(e) => setPartnerManagerId(e.target.value)}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
                >
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>{m.fullName}</option>
                  ))}
                </select>
              </label>
              <AddPartnerForm
                onAdd={(data) => { onAddPartner({ ...data, managerId: partnerManagerId }); setOpenPartner(false); }}
                onClose={() => setOpenPartner(false)}
              />
            </>
          )
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-slate-800 text-sm">Добавить клиента</h3>
          <button onClick={() => setOpenClient(!openClient)} className="text-teal-700 text-sm font-medium hover:underline">
            {openClient ? "Скрыть" : "Открыть"}
          </button>
        </div>
        {openClient && (
          managers.length === 0 ? (
            <div className="text-sm text-slate-400">Сначала должен зарегистрироваться менеджер</div>
          ) : (
            <>
              <label className="block mb-3">
                <span className="text-xs font-medium text-slate-500">Партнёр-менеджер</span>
                <select
                  value={clientManagerId}
                  onChange={(e) => { setClientManagerId(e.target.value); setClientPartnerId(""); }}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
                >
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>{m.fullName}</option>
                  ))}
                </select>
              </label>
              {clientPartnerOptions.length === 0 ? (
                <div className="text-sm text-slate-400">У этого менеджера пока нет партнёров</div>
              ) : (
                <>
                  <label className="block mb-3">
                    <span className="text-xs font-medium text-slate-500">Партнёр</span>
                    <select
                      value={clientPartnerId || clientPartnerOptions[0].id}
                      onChange={(e) => setClientPartnerId(e.target.value)}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
                    >
                      {clientPartnerOptions.map((p) => (
                        <option key={p.id} value={p.id}>{p.name} · {p.city}</option>
                      ))}
                    </select>
                  </label>
                  <AddClientForm
                    onAdd={(data) => { onAddClient(clientPartnerId || clientPartnerOptions[0].id, data); setOpenClient(false); }}
                    onClose={() => setOpenClient(false)}
                  />
                </>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}

function ManagerDashboard({ me, partners, clients, saving, onLogout, onAddPartner, onUpdatePartnerInfo, onUpdateClientInfo, onAddClient, paidCountForManager, paidCountForPartner, managerOwed, partnerOwed, partnerPaidOutTotal, managerPaidOutTotal, managerClientBreakdown, managerPayouts, selectedPartnerId, setSelectedPartnerId }) {
  const [tab, setTab] = useState("overview");
  const paidCount = me ? paidCountForManager(me.id) : 0;
  const owed = me ? managerOwed(me.id) : 0;
  const paidOutTotal = me ? managerPaidOutTotal(me.id) : 0;
  const breakdown = me ? managerClientBreakdown(me.id) : [];
  const history = me ? managerPayouts.filter((p) => p.managerId === me.id).slice().reverse() : [];
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("ru-RU") : "");

  const partnerRows = partners.map((p) => {
    const paidOut = partnerPaidOutTotal(p.id);
    const owed = partnerOwed(p.id);
    return { id: p.id, name: p.name, sub: `${p.city} · ${p.niche}`, earned: paidOut + owed, paidOut, owed };
  });

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <TopBar title={me ? me.fullName : "Менеджер"} subtitle={me?.city} onLogout={onLogout} saving={saving} />
      <div className="max-w-2xl mx-auto p-4">
        <div className="bg-teal-700 text-white rounded-2xl p-5 mb-5">
          <div className="flex items-center gap-2 text-teal-100 text-sm mb-1">
            <TrendingUp className="w-4 h-4" /> К выплате вам сейчас
          </div>
          <div className="text-3xl font-bold">{money(owed)}</div>
          <div className="text-teal-100 text-sm mt-1">Всего приведено {paidCount} оплаченных клиентов · {currentTierLabel(paidCount)}</div>
          <div className="text-teal-100 text-xs mt-1">Уже выплачено вам: {money(paidOutTotal)}</div>
        </div>

        <TabNav
          active={tab}
          onChange={setTab}
          tabs={[
            { key: "overview", label: "Партнёры", icon: LayoutGrid },
            { key: "analytics", label: "Аналитика", icon: BarChart3 },
            { key: "add", label: "Добавить", icon: PlusCircle },
          ]}
        />

        {tab === "overview" && (
          partners.length === 0 ? (
            <div className="text-sm text-slate-400 text-center py-10">Пока нет партнёров — добавьте на вкладке «Добавить»</div>
          ) : (
            <PartnersList
              partners={partners}
              clients={clients}
              isOwner={false}
              onUpdatePartnerInfo={onUpdatePartnerInfo}
              onUpdateClientInfo={onUpdateClientInfo}
              onAddClient={onAddClient}
              paidCountForPartner={paidCountForPartner}
              partnerOwed={partnerOwed}
              partnerPaidOutTotal={partnerPaidOutTotal}
              selectedPartnerId={selectedPartnerId}
              setSelectedPartnerId={setSelectedPartnerId}
            />
          )
        )}

        {tab === "analytics" && (
          <>
            <EarningsAnalytics title="По моим партнёрам" rows={partnerRows} filterLabel="Партнёр" />
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
              <div>
                <div className="text-xs font-medium text-slate-500 mb-2">Сколько принёс каждый клиент</div>
                {breakdown.length === 0 ? (
                  <div className="text-sm text-slate-400">Оплаченных клиентов пока нет</div>
                ) : (
                  <div className="space-y-1">
                    {breakdown.map((b) => (
                      <div key={b.client.id} className="flex items-center justify-between text-sm py-1 border-b border-slate-50 last:border-0">
                        <span className="text-slate-700">#{b.position} {b.client.name} <span className="text-slate-400">· {b.partnerName}</span></span>
                        <span className="font-medium text-slate-800">{money(b.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500 mb-2">История выплат вам</div>
                {history.length === 0 ? (
                  <div className="text-sm text-slate-400">Выплат пока не было</div>
                ) : (
                  <div className="space-y-1">
                    {history.map((h) => (
                      <div key={h.id} className="flex items-center justify-between text-sm py-1 border-b border-slate-50 last:border-0">
                        <span className="text-slate-500">{fmtDate(h.date)}</span>
                        <span className="font-medium text-slate-800">{money(h.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {tab === "add" && (
          <ManagerAddPanel partners={partners} onAddPartner={onAddPartner} onAddClient={onAddClient} />
        )}
      </div>
    </div>
  );
}

function OwnerDashboard({ managers, partners, clients, saving, onLogout, onAddPartner, onTogglePaid, onTogglePartnerPaid, onUpdatePartnerRate, onUpdatePartnerInfo, onUpdateClientAmount, onUpdateClientNote, onUpdateClientInfo, totalRevenue, onAddClient, paidCountForManager, paidCountForPartner, managerOwed, partnerOwed, managerPaidOutTotal, partnerPaidOutTotal, managerClientBreakdown, managerPayouts, onPayoutManager, selectedPartnerId, setSelectedPartnerId }) {
  const [tab, setTab] = useState("overview");
  const [activeManagerId, setActiveManagerId] = useState(null);
  const [showAddPartner, setShowAddPartner] = useState(false);
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("ru-RU") : "");

  const totalPaidClients = clients.filter((c) => c.paid).length;
  const totalManagerPayout = managers.reduce((sum, m) => sum + managerOwed(m.id), 0);
  const totalPartnerPayout = partners.reduce((sum, p) => sum + partnerOwed(p.id), 0);

  const activeManager = managers.find((m) => m.id === activeManagerId);
  const managerPartners = activeManagerId ? partners.filter((p) => p.managerId === activeManagerId) : [];
  const activeBreakdown = activeManagerId ? managerClientBreakdown(activeManagerId) : [];
  const activeHistory = activeManagerId ? managerPayouts.filter((p) => p.managerId === activeManagerId).slice().reverse() : [];

  const managerRows = managers.map((m) => ({
    id: m.id,
    name: m.fullName,
    sub: m.city,
    earned: managerEarnings(paidCountForManager(m.id)),
    paidOut: managerPaidOutTotal(m.id),
    owed: managerOwed(m.id),
  }));
  const [analyticsManagerId, setAnalyticsManagerId] = useState("all");
  const analyticsPartners = analyticsManagerId === "all" ? partners : partners.filter((p) => p.managerId === analyticsManagerId);
  const partnerRows = analyticsPartners.map((p) => {
    const paidOut = partnerPaidOutTotal(p.id);
    const owed = partnerOwed(p.id);
    return { id: p.id, name: p.name, sub: `${p.city} · ${p.niche}`, earned: paidOut + owed, paidOut, owed };
  });

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <TopBar title="Brocs · Панель владельца" subtitle={`${managers.length} менеджеров · ${partners.length} партнёров · ${totalPaidClients} оплаченных клиентов`} onLogout={onLogout} saving={saving} />

      <div className="max-w-3xl mx-auto p-4">
        <div className="grid grid-cols-3 gap-3 mb-5">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs text-slate-500 mb-1">Выручка</div>
            <div className="text-xl font-bold text-slate-800">{money(totalRevenue)}</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs text-slate-500 mb-1">К выплате менеджерам</div>
            <div className="text-xl font-bold text-slate-800">{money(totalManagerPayout)}</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs text-slate-500 mb-1">К выплате партнёрам</div>
            <div className="text-xl font-bold text-slate-800">{money(totalPartnerPayout)}</div>
          </div>
        </div>

        <TabNav
          active={tab}
          onChange={setTab}
          tabs={[
            { key: "overview", label: "Обзор", icon: LayoutGrid },
            { key: "analytics", label: "Аналитика", icon: BarChart3 },
            { key: "export", label: "Экспорт", icon: Download },
            { key: "add", label: "Добавить", icon: PlusCircle },
          ]}
        />

        {tab === "export" && (
          <ExportPanel
            managers={managers}
            partners={partners}
            clients={clients}
            paidCountForManager={paidCountForManager}
            managerOwed={managerOwed}
            managerPaidOutTotal={managerPaidOutTotal}
            paidCountForPartner={paidCountForPartner}
            partnerOwed={partnerOwed}
            partnerPaidOutTotal={partnerPaidOutTotal}
          />
        )}

        {tab === "analytics" && (
          <>
            <EarningsAnalytics title="По менеджерам" rows={managerRows} filterLabel="Менеджер" />

            <div className="mb-2">
              <select
                value={analyticsManagerId}
                onChange={(e) => setAnalyticsManagerId(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                <option value="all">Партнёры: все менеджеры</option>
                {managers.map((m) => (
                  <option key={m.id} value={m.id}>Партнёры менеджера: {m.fullName}</option>
                ))}
              </select>
            </div>
            <EarningsAnalytics title="По партнёрам" rows={partnerRows} filterLabel="Партнёр" />
          </>
        )}

        {tab === "add" && (
          <OwnerAddPanel managers={managers} partners={partners} onAddPartner={onAddPartner} onAddClient={onAddClient} />
        )}

        {tab === "overview" && !activeManagerId && (
          <>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-slate-800">Партнёр-менеджеры</h2>
              <span className="text-xs text-slate-400">Регистрируются сами по ссылке на вход</span>
            </div>

            <div className="space-y-2">
              {managers.length === 0 && <div className="text-sm text-slate-400 text-center py-10">Менеджеров пока нет — как только кто-то зарегистрируется, он появится здесь</div>}
              {managers.map((m) => {
                const paidCount = paidCountForManager(m.id);
                const mPartners = partners.filter((p) => p.managerId === m.id);
                return (
                  <button
                    key={m.id}
                    onClick={() => setActiveManagerId(m.id)}
                    className="w-full text-left bg-white border border-slate-200 rounded-xl px-4 py-3 flex items-center justify-between hover:border-teal-600"
                  >
                    <div>
                      <div className="font-medium text-slate-800">{m.fullName}</div>
                      <div className="text-xs text-slate-500">{m.city} · с {m.startDate} · {mPartners.length} партнёров</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-semibold text-teal-700">{money(managerOwed(m.id))}</div>
                      <div className="text-xs text-slate-400">{paidCount} оплач. всего</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {tab === "overview" && activeManagerId && (
          <>
            <button onClick={() => { setActiveManagerId(null); setSelectedPartnerId(null); }} className="flex items-center gap-1 text-slate-500 text-sm mb-4 hover:text-slate-700">
              <ChevronLeft className="w-4 h-4" /> Все менеджеры
            </button>

            <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
              <div className="font-semibold text-slate-800">{activeManager?.fullName}</div>
              <div className="text-xs text-slate-500 mt-0.5">
                {activeManager?.city} · ИИН: {activeManager?.idNumber} · {activeManager?.email} · с {activeManager?.startDate}
              </div>
              <div className="text-xs text-slate-500 mt-1 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 inline-block">
                Логин: <span className="font-medium text-slate-700">{activeManager?.login}</span> · Пароль: <span className="font-medium text-slate-700">{activeManager?.password}</span>
              </div>
              <div className="mt-2 text-sm text-teal-700 font-medium">
                {money(managerOwed(activeManagerId))} к выплате · всего приведено {paidCountForManager(activeManagerId)} клиентов · {currentTierLabel(paidCountForManager(activeManagerId))}
              </div>
              <div className="text-xs text-slate-500 mt-1">Уже выплачено: {money(managerPaidOutTotal(activeManagerId))}</div>
              <button
                disabled={managerOwed(activeManagerId) <= 0}
                onClick={() => onPayoutManager(activeManagerId)}
                className="w-full mt-3 bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-emerald-700 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Выплатили менеджеру {money(managerOwed(activeManagerId))}
              </button>

              {(activeBreakdown.length > 0 || activeHistory.length > 0) && (
                <div className="mt-4 pt-3 border-t border-slate-100 space-y-4">
                  {activeBreakdown.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-slate-500 mb-2">Сколько принёс каждый клиент</div>
                      <div className="space-y-1">
                        {activeBreakdown.map((b) => (
                          <div key={b.client.id} className="flex items-center justify-between text-sm py-1 border-b border-slate-50 last:border-0">
                            <span className="text-slate-700">#{b.position} {b.client.name} <span className="text-slate-400">· {b.partnerName}</span></span>
                            <span className="font-medium text-slate-800">{money(b.amount)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {activeHistory.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-slate-500 mb-2">История выплат менеджеру</div>
                      <div className="space-y-1">
                        {activeHistory.map((h) => (
                          <div key={h.id} className="flex items-center justify-between text-sm py-1 border-b border-slate-50 last:border-0">
                            <span className="text-slate-500">{fmtDate(h.date)}</span>
                            <span className="font-medium text-slate-800">{money(h.amount)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-slate-800">Партнёры ({managerPartners.length})</h3>
              <button onClick={() => setShowAddPartner(!showAddPartner)} className="text-teal-700 text-sm font-medium flex items-center gap-1 hover:underline">
                <Plus className="w-4 h-4" /> Партнёр
              </button>
            </div>
            {showAddPartner && (
              <AddPartnerForm
                onAdd={(data) => onAddPartner({ ...data, managerId: activeManagerId })}
                onClose={() => setShowAddPartner(false)}
              />
            )}

            {managerPartners.length === 0 ? (
              <div className="text-sm text-slate-400 text-center py-10">У этого менеджера пока нет партнёров</div>
            ) : (
              <PartnersList
                partners={managerPartners}
                clients={clients}
                isOwner={true}
                onTogglePaid={onTogglePaid}
                onTogglePartnerPaid={onTogglePartnerPaid}
                onUpdatePartnerRate={onUpdatePartnerRate}
                onUpdatePartnerInfo={onUpdatePartnerInfo}
                onUpdateClientAmount={onUpdateClientAmount}
                onUpdateClientNote={onUpdateClientNote}
                onUpdateClientInfo={onUpdateClientInfo}
                onAddClient={onAddClient}
                paidCountForPartner={paidCountForPartner}
                partnerOwed={partnerOwed}
                partnerPaidOutTotal={partnerPaidOutTotal}
                selectedPartnerId={selectedPartnerId}
                setSelectedPartnerId={setSelectedPartnerId}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
