import { describe, expect, it } from "vitest";
import { EquipmentStatus } from "../../src/business/entities/equipment.entity.js";
import { DomainErrorCode } from "../../src/business/entities/errors.entity.js";
import { LoanDisplayStatus, LoanStatus } from "../../src/business/entities/loan.entity.js";
import { Role } from "../../src/business/entities/user.entity.js";
import { expectDomainError } from "../support/expect-domain-error.js";
import { setup, TODAY } from "../support/setup.js";

describe("CU-03 registrar préstamo", () => {
  it("crea el préstamo Activo y marca el equipo Prestado en una transacción", async () => {
    const { useCases, manager, ana, addEquipment, uow } = setup();
    const laptop = addEquipment({ code: "LAP-001", name: "MacBook Pro 14" });
    const loan = await useCases.loans.createLoan(manager, {
      employeeId: ana.id,
      equipmentId: laptop.id,
      dueOn: "2026-10-20",
    });
    expect(loan).toMatchObject({
      employeeId: ana.id,
      equipmentId: laptop.id,
      borrowedOn: TODAY,
      dueOn: "2026-10-20",
      returnedOn: null,
      status: LoanStatus.Active,
      displayStatus: LoanDisplayStatus.Active,
      equipmentCode: "LAP-001",
      equipmentName: "MacBook Pro 14",
      employeeName: "Ana García",
    });
    expect(uow.store.equipment.get(laptop.id)?.status).toBe(EquipmentStatus.Loaned);
    expect(uow.transactions.committed).toBe(1);
  });

  it("acepta como fecha prevista el mismo día", async () => {
    const { useCases, manager, ana, addEquipment } = setup();
    const loan = await useCases.loans.createLoan(manager, {
      employeeId: ana.id,
      equipmentId: addEquipment().id,
      dueOn: TODAY,
    });
    expect(loan.displayStatus).toBe(LoanDisplayStatus.DueSoon);
  });

  it("rechaza una fecha prevista anterior a hoy", async () => {
    const { useCases, manager, ana, addEquipment } = setup();
    await expectDomainError(
      useCases.loans.createLoan(manager, {
        employeeId: ana.id,
        equipmentId: addEquipment().id,
        dueOn: "2026-10-06",
      }),
      {
        code: DomainErrorCode.Validation,
        fields: { dueOn: "La fecha prevista no puede ser anterior a hoy." },
      },
    );
  });

  it("rechaza un equipo que no está disponible", async () => {
    const { useCases, manager, ana, addEquipment } = setup();
    const loaned = addEquipment({ status: EquipmentStatus.Loaned });
    await expectDomainError(
      useCases.loans.createLoan(manager, {
        employeeId: ana.id,
        equipmentId: loaned.id,
        dueOn: "2026-10-20",
      }),
      {
        code: DomainErrorCode.Conflict,
        fields: { equipmentId: "El equipo seleccionado no está disponible." },
      },
    );
  });

  it("rechaza si ya existe un préstamo activo del equipo aunque su estado diga Disponible", async () => {
    const { useCases, manager, ana, addEquipment, addLoan, uow } = setup();
    const laptop = addEquipment();
    addLoan({ employeeId: ana.id, equipmentId: laptop.id });
    const row = uow.store.equipment.get(laptop.id);
    if (row) row.status = EquipmentStatus.Available;
    await expectDomainError(
      useCases.loans.createLoan(manager, {
        employeeId: ana.id,
        equipmentId: laptop.id,
        dueOn: "2026-10-20",
      }),
      { code: DomainErrorCode.Conflict },
    );
  });

  it("rechaza equipos o empleados inexistentes y empleados inactivos", async () => {
    const { useCases, manager, ana, addEquipment, addEmployee } = setup();
    const laptop = addEquipment();
    await expectDomainError(
      useCases.loans.createLoan(manager, { employeeId: ana.id, equipmentId: "no-existe", dueOn: "2026-10-20" }),
      { code: DomainErrorCode.NotFound, fields: { equipmentId: "El equipo seleccionado no está disponible." } },
    );
    await expectDomainError(
      useCases.loans.createLoan(manager, { employeeId: "no-existe", equipmentId: laptop.id, dueOn: "2026-10-20" }),
      { code: DomainErrorCode.NotFound, fields: { employeeId: "Selecciona un empleado activo." } },
    );
    const inactive = addEmployee({ active: false });
    await expectDomainError(
      useCases.loans.createLoan(manager, { employeeId: inactive.id, equipmentId: laptop.id, dueOn: "2026-10-20" }),
      { code: DomainErrorCode.Conflict, fields: { employeeId: "Selecciona un empleado activo." } },
    );
  });

  it("un Empleado no puede registrar préstamos", async () => {
    const { useCases, employee, ana, addEquipment } = setup();
    await expectDomainError(
      useCases.loans.createLoan(employee, { employeeId: ana.id, equipmentId: addEquipment().id, dueOn: "2026-10-20" }),
      { code: DomainErrorCode.Forbidden },
    );
  });

  it("si falla a mitad de la transacción no queda ni el préstamo ni el cambio de estado", async () => {
    const { useCases, manager, ana, addEquipment, uow } = setup();
    const laptop = addEquipment();
    uow.beforeWrite = (operation) => {
      if (operation === "equipment.updateStatus") throw new Error("DB caída");
    };
    const failed = await useCases.loans
      .createLoan(manager, { employeeId: ana.id, equipmentId: laptop.id, dueOn: "2026-10-20" })
      .then(() => null, (error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(uow.store.loans.size).toBe(0);
    expect(uow.store.equipment.get(laptop.id)?.status).toBe(EquipmentStatus.Available);
    expect(uow.transactions.rolledBack).toBe(1);
  });

  it("dos préstamos simultáneos del mismo equipo: solo uno pasa", async () => {
    const { useCases, manager, ana, addEquipment, addEmployee, uow } = setup();
    const laptop = addEquipment();
    const carlos = addEmployee({ firstName: "Carlos", lastName: "Ruiz" });
    const results = await Promise.allSettled([
      useCases.loans.createLoan(manager, { employeeId: ana.id, equipmentId: laptop.id, dueOn: "2026-10-20" }),
      useCases.loans.createLoan(manager, { employeeId: carlos.id, equipmentId: laptop.id, dueOn: "2026-10-21" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(uow.store.loans.size).toBe(1);
  });
});

describe("CU-04 registrar devolución", () => {
  it("cierra el préstamo y libera el equipo en una transacción", async () => {
    const { useCases, manager, ana, addEquipment, addLoan, uow } = setup();
    const laptop = addEquipment();
    const loan = addLoan({ employeeId: ana.id, equipmentId: laptop.id });
    const returned = await useCases.loans.returnLoan(manager, loan.id);
    expect(returned).toMatchObject({
      id: loan.id,
      status: LoanStatus.Returned,
      displayStatus: LoanDisplayStatus.Returned,
      returnedOn: TODAY,
      employeeName: "Ana García",
    });
    expect(uow.store.loans.get(loan.id)?.status).toBe(LoanStatus.Returned);
    expect(uow.store.equipment.get(laptop.id)?.status).toBe(EquipmentStatus.Available);
  });

  it("rechaza un préstamo ya devuelto o inexistente", async () => {
    const { useCases, manager, ana, addEquipment, addLoan } = setup();
    const loan = addLoan({
      employeeId: ana.id,
      equipmentId: addEquipment().id,
      status: LoanStatus.Returned,
      returnedOn: "2026-10-05",
    });
    await expectDomainError(useCases.loans.returnLoan(manager, loan.id), {
      code: DomainErrorCode.Conflict,
      message: "Este préstamo ya fue devuelto.",
    });
    await expectDomainError(useCases.loans.returnLoan(manager, "no-existe"), {
      code: DomainErrorCode.NotFound,
    });
  });

  it("si falla a mitad de la transacción el préstamo sigue Activo", async () => {
    const { useCases, manager, ana, addEquipment, addLoan, uow } = setup();
    const laptop = addEquipment();
    const loan = addLoan({ employeeId: ana.id, equipmentId: laptop.id });
    uow.beforeWrite = (operation) => {
      if (operation === "equipment.updateStatus") throw new Error("DB caída");
    };
    await useCases.loans.returnLoan(manager, loan.id).catch(() => undefined);
    expect(uow.store.loans.get(loan.id)?.status).toBe(LoanStatus.Active);
    expect(uow.store.loans.get(loan.id)?.returnedOn).toBeNull();
    expect(uow.store.equipment.get(laptop.id)?.status).toBe(EquipmentStatus.Loaned);
  });

  it("un Empleado no puede registrar devoluciones", async () => {
    const { useCases, employee, ana, addEquipment, addLoan } = setup();
    const loan = addLoan({ employeeId: ana.id, equipmentId: addEquipment().id });
    await expectDomainError(useCases.loans.returnLoan(employee, loan.id), {
      code: DomainErrorCode.Forbidden,
    });
  });
});

describe("CU-06 consultar préstamos", () => {
  const scenario = () => {
    const context = setup();
    const { ana, addEmployee, addEquipment, addLoan } = context;
    const carlos = addEmployee({ firstName: "Carlos", lastName: "Ruiz" });
    const overdue = addLoan({ employeeId: ana.id, equipmentId: addEquipment().id, dueOn: "2026-10-05" });
    const dueSoon = addLoan({ employeeId: carlos.id, equipmentId: addEquipment().id, dueOn: "2026-10-09" });
    const active = addLoan({ employeeId: ana.id, equipmentId: addEquipment().id, dueOn: "2026-10-30" });
    const returned = addLoan({
      employeeId: carlos.id,
      equipmentId: addEquipment().id,
      dueOn: "2026-10-03",
      status: LoanStatus.Returned,
      returnedOn: "2026-10-02",
    });
    return { ...context, carlos, overdue, dueSoon, active, returned };
  };

  it("el Encargado ve todos, ordenados por fecha prevista y con el estado derivado", async () => {
    const { useCases, manager } = scenario();
    const loans = await useCases.loans.listLoans(manager);
    expect(loans.map((loan) => [loan.dueOn, loan.displayStatus])).toEqual([
      ["2026-10-03", LoanDisplayStatus.Returned],
      ["2026-10-05", LoanDisplayStatus.Overdue],
      ["2026-10-09", LoanDisplayStatus.DueSoon],
      ["2026-10-30", LoanDisplayStatus.Active],
    ]);
  });

  it("filtra por estado derivado y por empleado", async () => {
    const { useCases, manager, overdue, dueSoon, carlos } = scenario();
    const late = await useCases.loans.listLoans(manager, { status: LoanDisplayStatus.Overdue });
    expect(late.map((loan) => loan.id)).toEqual([overdue.id]);
    const soon = await useCases.loans.listLoans(manager, { status: LoanDisplayStatus.DueSoon });
    expect(soon.map((loan) => loan.id)).toEqual([dueSoon.id]);
    expect(await useCases.loans.listLoans(manager, { employeeId: carlos.id })).toHaveLength(2);
  });

  it("el Empleado solo ve sus propios préstamos, aunque pida los de otro", async () => {
    const { useCases, employee, overdue, active, carlos } = scenario();
    const own = await useCases.loans.listLoans(employee, { employeeId: carlos.id });
    expect(own.map((loan) => loan.id)).toEqual([overdue.id, active.id]);
  });

  it("un Empleado sin empleado vinculado no ve préstamos", async () => {
    const { useCases, addUser } = scenario();
    const user = addUser({ employeeId: null });
    const loans = await useCases.loans.listLoans({
      userId: user.id,
      role: Role.Employee,
      employeeId: null,
    });
    expect(loans).toEqual([]);
  });
});
