import { fullName, type Employee } from "../../src/business/entities/employee.entity.js";
import type { Equipment } from "../../src/business/entities/equipment.entity.js";
import { DomainError, DomainErrorCode } from "../../src/business/entities/errors.entity.js";
import { LoanStatus, type Loan, type LoanDetails } from "../../src/business/entities/loan.entity.js";
import type { Session } from "../../src/business/entities/session.entity.js";
import type { PublicUser, User } from "../../src/business/entities/user.entity.js";
import type { Clock } from "../../src/business/ports/clock.js";
import type { AccountNotifier } from "../../src/business/ports/notifier.js";
import type { Repositories } from "../../src/business/ports/repositories.js";
import type { PasswordHasher } from "../../src/business/ports/security.js";
import type { UnitOfWork } from "../../src/business/ports/unit-of-work.js";
import { DEFAULT_TIME_ZONE } from "../../src/business/rules/clock.rules.js";
import { isoDateInTimeZone } from "../../src/business/rules/dates.rules.js";

export interface Store {
  equipment: Map<string, Equipment>;
  employees: Map<string, Employee>;
  loans: Map<string, Loan>;
  users: Map<string, User>;
  sessions: Map<string, Session>;
}

export interface InMemoryUnitOfWork extends UnitOfWork {
  readonly store: Store;
  beforeWrite: (operation: string) => void;
  readonly transactions: { committed: number; rolledBack: number };
}

const emptyStore = (): Store => ({
  equipment: new Map(),
  employees: new Map(),
  loans: new Map(),
  users: new Map(),
  sessions: new Map(),
});

const copy = <T extends object>(row: T): T => structuredClone(row);
const conflict = (field: string) =>
  new DomainError("Registro duplicado.", DomainErrorCode.Conflict, { [field]: "Registro duplicado." });

export function createInMemoryUnitOfWork(): InMemoryUnitOfWork {
  let store = emptyStore();
  let queue: Promise<unknown> = Promise.resolve();
  const write = (operation: string) => uow.beforeWrite(operation);
  const values = <T extends object>(map: Map<string, T>): T[] =>
    [...map.values()].map((row) => copy(row));

  const details = (loan: Loan): LoanDetails => {
    const equipment = store.equipment.get(loan.equipmentId);
    const employee = store.employees.get(loan.employeeId);
    return {
      ...copy(loan),
      equipmentCode: equipment?.code ?? "",
      equipmentName: equipment?.name ?? "",
      employeeName: employee ? fullName(employee) : "",
    };
  };

  const repositories: Repositories = {
    equipment: {
      async list(filter) {
        return values(store.equipment).filter(
          (row) => !filter?.status || row.status === filter.status,
        );
      },
      async findById(id) {
        const row = store.equipment.get(id);
        return row ? copy(row) : null;
      },
      async findByIdForUpdate(id) {
        return repositories.equipment.findById(id);
      },
      async findByCode(code) {
        return values(store.equipment).find((row) => row.code === code) ?? null;
      },
      async insert(equipment) {
        write("equipment.insert");
        if (values(store.equipment).some((row) => row.code === equipment.code))
          throw conflict("code");
        store.equipment.set(equipment.id, copy(equipment));
      },
      async updateStatus(id, status) {
        write("equipment.updateStatus");
        const row = store.equipment.get(id);
        if (row) row.status = status;
      },
    },
    employees: {
      async list() {
        return values(store.employees);
      },
      async findById(id) {
        const row = store.employees.get(id);
        return row ? copy(row) : null;
      },
      async findByIdForUpdate(id) {
        return repositories.employees.findById(id);
      },
      async findByIdentity(identity) {
        return values(store.employees).find((row) => row.identity === identity) ?? null;
      },
      async insert(employee) {
        write("employees.insert");
        if (values(store.employees).some((row) => row.identity === employee.identity))
          throw conflict("identity");
        store.employees.set(employee.id, copy(employee));
      },
      async setActive(id, active) {
        write("employees.setActive");
        const row = store.employees.get(id);
        if (row) row.active = active;
      },
    },
    loans: {
      async list(filter) {
        return [...store.loans.values()]
          .filter(
            (loan) =>
              (!filter?.employeeId || loan.employeeId === filter.employeeId) &&
              (!filter?.status || loan.status === filter.status),
          )
          .map(details);
      },
      async findById(id) {
        const loan = store.loans.get(id);
        return loan ? details(loan) : null;
      },
      async findByIdForUpdate(id) {
        return repositories.loans.findById(id);
      },
      async findActiveByEquipment(equipmentId) {
        const loan = [...store.loans.values()].find(
          (row) => row.equipmentId === equipmentId && row.status === LoanStatus.Active,
        );
        return loan ? copy(loan) : null;
      },
      async insert(loan) {
        write("loans.insert");
        if (
          loan.status === LoanStatus.Active &&
          [...store.loans.values()].some(
            (row) => row.equipmentId === loan.equipmentId && row.status === LoanStatus.Active,
          )
        )
          throw conflict("equipmentId");
        store.loans.set(loan.id, copy(loan));
      },
      async markReturned(id, returnedOn) {
        write("loans.markReturned");
        const row = store.loans.get(id);
        if (row) Object.assign(row, { returnedOn, status: LoanStatus.Returned });
      },
    },
    users: {
      async list() {
        return values(store.users);
      },
      async findById(id) {
        const row = store.users.get(id);
        return row ? copy(row) : null;
      },
      async findByEmail(email) {
        return values(store.users).find((row) => row.email === email) ?? null;
      },
      async findByEmployeeId(employeeId) {
        return values(store.users).find((row) => row.employeeId === employeeId) ?? null;
      },
      async insert(user) {
        write("users.insert");
        if (values(store.users).some((row) => row.email === user.email))
          throw conflict("email");
        if (
          user.employeeId &&
          values(store.users).some((row) => row.employeeId === user.employeeId)
        )
          throw conflict("employeeId");
        store.users.set(user.id, copy(user));
      },
      async updateStatus(id, status) {
        write("users.updateStatus");
        const row = store.users.get(id);
        if (row) row.status = status;
      },
    },
    sessions: {
      async findById(id) {
        const row = store.sessions.get(id);
        return row ? copy(row) : null;
      },
      async insert(session) {
        write("sessions.insert");
        store.sessions.set(session.id, copy(session));
      },
      async touch(id, lastSeenAt, expiresAt) {
        write("sessions.touch");
        const row = store.sessions.get(id);
        if (row && row.lastSeenAt.getTime() < lastSeenAt.getTime())
          Object.assign(row, { lastSeenAt, expiresAt });
      },
      async delete(id) {
        write("sessions.delete");
        store.sessions.delete(id);
      },
      async deleteByUserId(userId) {
        write("sessions.deleteByUserId");
        for (const [id, row] of store.sessions)
          if (row.userId === userId) store.sessions.delete(id);
      },
    },
  };

  const uow: InMemoryUnitOfWork = {
    get store() {
      return store;
    },
    beforeWrite: () => undefined,
    transactions: { committed: 0, rolledBack: 0 },
    repositories,
    transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
      const run = async () => {
        const snapshot = structuredClone(store);
        try {
          const result = await work(repositories);
          uow.transactions.committed++;
          return result;
        } catch (error) {
          store = snapshot;
          uow.transactions.rolledBack++;
          throw error;
        }
      };
      const result = queue.then(run, run);
      queue = result.catch(() => undefined);
      return result;
    },
  };
  return uow;
}

export interface FakeClock extends Clock {
  advance(ms: number): void;
}

export function createFakeClock(start = "2026-10-07T12:00:00.000Z"): FakeClock {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    today: () => isoDateInTimeZone(new Date(current), DEFAULT_TIME_ZONE),
    advance(ms) {
      current += ms;
    },
  };
}

export interface FakePasswordHasher extends PasswordHasher {
  readonly calls: { hash: number; verify: number };
}

export function createFakePasswordHasher(): FakePasswordHasher {
  const calls = { hash: 0, verify: 0 };
  return {
    calls,
    async hash(password) {
      calls.hash++;
      return `hashed:${password}`;
    },
    async verify(password, passwordHash) {
      calls.verify++;
      return passwordHash === `hashed:${password}`;
    },
  };
}

export interface RecordingNotifier extends AccountNotifier {
  readonly events: { type: "invitation" | "recovery"; user: PublicUser }[];
}

export function createRecordingNotifier(): RecordingNotifier {
  const events: RecordingNotifier["events"] = [];
  return {
    events,
    async invitationCreated(user) {
      events.push({ type: "invitation", user });
    },
    async passwordRecoveryRequested(user) {
      events.push({ type: "recovery", user });
    },
  };
}
