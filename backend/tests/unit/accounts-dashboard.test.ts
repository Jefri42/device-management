import { describe, expect, it } from "vitest";
import { EquipmentStatus, EquipmentType } from "../../src/business/entities/equipment.entity.js";
import { DomainErrorCode } from "../../src/business/entities/errors.entity.js";
import { LoanStatus } from "../../src/business/entities/loan.entity.js";
import { Role, UserStatus } from "../../src/business/entities/user.entity.js";
import { hashSessionToken } from "../../src/business/rules/security.rules.js";
import { expectDomainError } from "../support/expect-domain-error.js";
import { DEMO_PASSWORD, setup } from "../support/setup.js";

describe("cuentas", () => {
  it("lista las cuentas sin exponer el hash de la contraseña", async () => {
    const { useCases, manager } = setup();
    const accounts = await useCases.accounts.listAccounts(manager);
    expect(accounts).toHaveLength(2);
    expect(accounts.some((account) => "passwordHash" in account)).toBe(false);
  });

  it("invita una cuenta vinculada a un empleado y toma su nombre", async () => {
    const { useCases, manager, addEmployee, notifier } = setup();
    const marta = addEmployee({ firstName: "Marta", lastName: "López" });
    const invited = await useCases.accounts.inviteAccount(manager, {
      email: "Marta.Lopez@empresa.com",
      role: Role.Employee,
      employeeId: marta.id,
    });
    expect(invited).toMatchObject({
      name: "Marta López",
      email: "marta.lopez@empresa.com",
      role: Role.Employee,
      status: UserStatus.Invited,
      employeeId: marta.id,
    });
    expect(notifier.events).toEqual([{ type: "invitation", user: invited }]);
  });

  it("invita una cuenta sin empleado usando el correo como nombre", async () => {
    const { useCases, manager } = setup();
    const invited = await useCases.accounts.inviteAccount(manager, {
      email: "soporte@empresa.com",
      role: Role.Manager,
      employeeId: "",
    });
    expect(invited).toMatchObject({ name: "soporte@empresa.com", employeeId: null, role: Role.Manager });
  });

  it("rechaza correos repetidos y empleados inactivos, inexistentes o ya vinculados", async () => {
    const { useCases, manager, ana, addEmployee } = setup();
    await expectDomainError(
      useCases.accounts.inviteAccount(manager, { email: "ana.garcia@empresa.com", role: Role.Employee }),
      { code: DomainErrorCode.Conflict, fields: { email: "Ya existe una cuenta con este correo." } },
    );
    const field = { employeeId: "Selecciona un empleado activo sin cuenta vinculada." };
    await expectDomainError(
      useCases.accounts.inviteAccount(manager, { email: "n1@empresa.com", role: Role.Employee, employeeId: ana.id }),
      { code: DomainErrorCode.Conflict, fields: field },
    );
    const inactive = addEmployee({ active: false });
    await expectDomainError(
      useCases.accounts.inviteAccount(manager, { email: "n2@empresa.com", role: Role.Employee, employeeId: inactive.id }),
      { code: DomainErrorCode.Conflict, fields: field },
    );
    await expectDomainError(
      useCases.accounts.inviteAccount(manager, { email: "n3@empresa.com", role: Role.Employee, employeeId: "no-existe" }),
      { code: DomainErrorCode.NotFound, fields: field },
    );
  });

  it("dos invitaciones simultáneas para el mismo empleado: solo una pasa", async () => {
    const { useCases, manager, addEmployee, uow } = setup();
    const marta = addEmployee({ firstName: "Marta", lastName: "López" });
    const results = await Promise.allSettled([
      useCases.accounts.inviteAccount(manager, { email: "m1@empresa.com", role: Role.Employee, employeeId: marta.id }),
      useCases.accounts.inviteAccount(manager, { email: "m2@empresa.com", role: Role.Employee, employeeId: marta.id }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect([...uow.store.users.values()].filter((user) => user.employeeId === marta.id)).toHaveLength(1);
  });

  it("si otra cuenta vincula al empleado justo antes del insert, responde CONFLICT", async () => {
    const { useCases, manager, addEmployee, addUser, uow } = setup();
    const marta = addEmployee({ firstName: "Marta", lastName: "López" });
    // Simula una transacción concurrente: la restricción única de la DB detiene la invitación.
    uow.beforeWrite = (operation) => {
      if (operation === "users.insert") addUser({ email: "otra@empresa.com", employeeId: marta.id });
    };
    await expectDomainError(
      useCases.accounts.inviteAccount(manager, { email: "m1@empresa.com", role: Role.Employee, employeeId: marta.id }),
      { code: DomainErrorCode.Conflict, fields: { employeeId: expect.any(String) } },
    );
  });

  it("desactiva la cuenta, su empleado y todas sus sesiones", async () => {
    const { useCases, manager, employeeUser, ana, uow } = setup();
    const { token } = await useCases.auth.login({ email: employeeUser.email, password: DEMO_PASSWORD });
    const deactivated = await useCases.accounts.deactivateAccount(manager, employeeUser.id);
    expect(deactivated.status).toBe(UserStatus.Inactive);
    expect(uow.store.users.get(employeeUser.id)?.status).toBe(UserStatus.Inactive);
    expect(uow.store.employees.get(ana.id)?.active).toBe(false);
    expect(uow.store.sessions.has(hashSessionToken(token))).toBe(false);
  });

  it("desactiva aunque tenga préstamos activos: se conservan y se pueden devolver", async () => {
    const { useCases, manager, employeeUser, ana, addEquipment, addLoan, uow } = setup();
    const laptop = addEquipment();
    const loan = addLoan({ employeeId: ana.id, equipmentId: laptop.id });
    await useCases.accounts.deactivateAccount(manager, employeeUser.id);
    expect(uow.store.users.get(employeeUser.id)?.status).toBe(UserStatus.Inactive);
    expect(uow.store.employees.get(ana.id)?.active).toBe(false);
    expect(uow.store.loans.get(loan.id)?.status).toBe(LoanStatus.Active);
    expect(uow.store.equipment.get(laptop.id)?.status).toBe(EquipmentStatus.Loaned);

    await useCases.loans.returnLoan(manager, loan.id);
    expect(uow.store.loans.get(loan.id)?.status).toBe(LoanStatus.Returned);
    await expectDomainError(
      useCases.loans.createLoan(manager, { employeeId: ana.id, equipmentId: laptop.id, dueOn: "2026-10-20" }),
      { code: DomainErrorCode.Conflict, fields: { employeeId: expect.any(String) } },
    );
  });

  it("no permite desactivar la propia cuenta, una inexistente o una ya inactiva", async () => {
    const { useCases, manager, addUser } = setup();
    await expectDomainError(useCases.accounts.deactivateAccount(manager, manager.userId), {
      code: DomainErrorCode.Conflict,
      message: "No puedes desactivar tu propia cuenta.",
    });
    await expectDomainError(useCases.accounts.deactivateAccount(manager, "no-existe"), {
      code: DomainErrorCode.NotFound,
    });
    const inactive = addUser({ status: UserStatus.Inactive });
    await expectDomainError(useCases.accounts.deactivateAccount(manager, inactive.id), {
      code: DomainErrorCode.Conflict,
      message: "La cuenta ya está inactiva.",
    });
  });

  it("solo el Encargado gestiona cuentas", async () => {
    const { useCases, employee, managerUser } = setup();
    await expectDomainError(useCases.accounts.listAccounts(employee), { code: DomainErrorCode.Forbidden });
    await expectDomainError(
      useCases.accounts.inviteAccount(employee, { email: "x@empresa.com", role: Role.Manager }),
      { code: DomainErrorCode.Forbidden },
    );
    await expectDomainError(useCases.accounts.deactivateAccount(employee, managerUser.id), {
      code: DomainErrorCode.Forbidden,
    });
  });
});

describe("dashboard", () => {
  const scenario = () => {
    const context = setup();
    const { ana, addEmployee, addEquipment, addLoan } = context;
    const carlos = addEmployee({ firstName: "Carlos", lastName: "Ruiz" });
    addEquipment({ type: EquipmentType.Monitor });
    const overdue = addLoan({ employeeId: ana.id, equipmentId: addEquipment().id, dueOn: "2026-10-05", borrowedOn: "2026-09-20" });
    const dueSoon = addLoan({ employeeId: carlos.id, equipmentId: addEquipment().id, dueOn: "2026-10-08", borrowedOn: "2026-10-06" });
    addLoan({ employeeId: ana.id, equipmentId: addEquipment({ type: EquipmentType.Tablet }).id, dueOn: "2026-10-30", borrowedOn: "2026-10-03" });
    const returned = addLoan({
      employeeId: carlos.id,
      equipmentId: addEquipment({ type: EquipmentType.Monitor }).id,
      borrowedOn: "2026-09-01",
      dueOn: "2026-09-15",
      status: LoanStatus.Returned,
      returnedOn: "2026-10-07",
    });
    return { ...context, overdue, dueSoon, returned };
  };

  it("el Encargado ve indicadores del inventario y de todos los préstamos", async () => {
    const { useCases, manager, overdue, dueSoon, returned } = scenario();
    const dashboard = await useCases.dashboard.getDashboard(manager);
    if (dashboard.role !== Role.Manager) throw new Error("Se esperaba el dashboard del Encargado");
    expect(dashboard.equipment).toEqual({ total: 5, available: 2, loaned: 3 });
    expect(dashboard.distribution).toEqual([
      { type: EquipmentType.Laptop, count: 2 },
      { type: EquipmentType.Monitor, count: 2 },
      { type: EquipmentType.Peripheral, count: 0 },
      { type: EquipmentType.Tablet, count: 1 },
    ]);
    expect(dashboard).toMatchObject({ activeLoans: 3, overdue: 1, dueSoon: 1 });
    expect(dashboard.pending.map((loan) => loan.id)).toEqual([overdue.id, dueSoon.id]);
    expect(dashboard.recent[0]?.id).toBe(returned.id);
    expect(dashboard.recent[1]?.id).toBe(dueSoon.id);
  });

  it("el Empleado solo ve sus préstamos, sin indicadores del inventario", async () => {
    const { useCases, employee, overdue } = scenario();
    const dashboard = await useCases.dashboard.getDashboard(employee);
    expect(dashboard.role).toBe(Role.Employee);
    expect("equipment" in dashboard).toBe(false);
    expect(dashboard).toMatchObject({ activeLoans: 2, overdue: 1, dueSoon: 0 });
    expect(dashboard.pending.map((loan) => loan.id)).toEqual([overdue.id]);
    expect(dashboard.recent.every((loan) => loan.employeeName === "Ana García")).toBe(true);
  });

  it("muestra como mucho 5 movimientos recientes", async () => {
    const { useCases, manager, ana, addEquipment, addLoan } = setup();
    for (let day = 1; day <= 7; day++)
      addLoan({
        employeeId: ana.id,
        equipmentId: addEquipment().id,
        borrowedOn: `2026-10-0${day}`,
        dueOn: "2026-10-30",
      });
    const dashboard = await useCases.dashboard.getDashboard(manager);
    expect(dashboard.recent.map((loan) => loan.borrowedOn)).toEqual([
      "2026-10-07",
      "2026-10-06",
      "2026-10-05",
      "2026-10-04",
      "2026-10-03",
    ]);
  });
});
