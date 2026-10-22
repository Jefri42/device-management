import { Department, type Employee } from "../../src/business/entities/employee.entity.js";
import { EquipmentStatus, EquipmentType, type Equipment } from "../../src/business/entities/equipment.entity.js";
import { LoanStatus, type Loan } from "../../src/business/entities/loan.entity.js";
import { actorFrom, Role, UserStatus, type Actor, type User } from "../../src/business/entities/user.entity.js";
import { uuidv7 } from "../../src/business/rules/id.rules.js";
import type { SessionPolicy } from "../../src/business/rules/session.rules.js";
import { createUseCases } from "../../src/business/use-cases/index.js";
import {
  createFakeClock,
  createFakePasswordHasher,
  createInMemoryUnitOfWork,
  createRecordingNotifier,
} from "./in-memory.js";

export const DEMO_PASSWORD = "Demo2026!";
export const TODAY = "2026-10-07";

export function setup(options: { sessionPolicy?: SessionPolicy } = {}) {
  const uow = createInMemoryUnitOfWork();
  const clock = createFakeClock();
  const passwordHasher = createFakePasswordHasher();
  const notifier = createRecordingNotifier();
  const useCases = createUseCases({
    uow,
    clock,
    passwordHasher,
    notifier,
    sessionPolicy: options.sessionPolicy,
  });

  const created = () => clock.now();
  const id = () => uuidv7(clock.now().getTime());

  const addEquipment = (data: Partial<Equipment> = {}): Equipment => {
    const equipment: Equipment = {
      id: id(),
      code: `LAP-${String(uow.store.equipment.size + 1).padStart(3, "0")}`,
      name: "MacBook Pro 14",
      type: EquipmentType.Laptop,
      brand: "Apple",
      model: "M3",
      status: EquipmentStatus.Available,
      createdAt: created(),
      ...data,
    };
    uow.store.equipment.set(equipment.id, equipment);
    return equipment;
  };

  const addEmployee = (data: Partial<Employee> = {}): Employee => {
    const number = String(uow.store.employees.size + 1).padStart(7, "0");
    const employee: Employee = {
      id: id(),
      firstName: "Ana",
      lastName: "García",
      identity: `001-${number}-1`,
      department: Department.Finance,
      phone: "",
      active: true,
      createdAt: created(),
      ...data,
    };
    uow.store.employees.set(employee.id, employee);
    return employee;
  };

  const addUser = (data: Partial<User> = {}): User => {
    const user: User = {
      id: id(),
      name: "Usuario",
      email: `usuario${uow.store.users.size + 1}@empresa.com`,
      role: Role.Employee,
      status: UserStatus.Active,
      employeeId: null,
      passwordHash: `hashed:${DEMO_PASSWORD}`,
      createdAt: created(),
      ...data,
    };
    uow.store.users.set(user.id, user);
    return user;
  };

  const addLoan = (data: Partial<Loan> & Pick<Loan, "employeeId" | "equipmentId">): Loan => {
    const loan: Loan = {
      id: id(),
      borrowedOn: "2026-10-01",
      dueOn: "2026-10-20",
      returnedOn: null,
      status: LoanStatus.Active,
      createdAt: created(),
      ...data,
    };
    uow.store.loans.set(loan.id, loan);
    if (loan.status === LoanStatus.Active) {
      const equipment = uow.store.equipment.get(loan.equipmentId);
      if (equipment) equipment.status = EquipmentStatus.Loaned;
    }
    return loan;
  };

  const managerUser = addUser({
    name: "Laura Méndez",
    email: "laura.mendez@empresa.com",
    role: Role.Manager,
  });
  const ana = addEmployee();
  const employeeUser = addUser({
    name: "Ana García",
    email: "ana.garcia@empresa.com",
    employeeId: ana.id,
  });
  const manager: Actor = actorFrom(managerUser);
  const employee: Actor = actorFrom(employeeUser);

  return {
    uow,
    clock,
    passwordHasher,
    notifier,
    useCases,
    manager,
    managerUser,
    employee,
    employeeUser,
    ana,
    addEquipment,
    addEmployee,
    addUser,
    addLoan,
  };
}

export type TestContext = ReturnType<typeof setup>;
