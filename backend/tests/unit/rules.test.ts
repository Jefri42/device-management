import { describe, expect, it } from "vitest";
import { LoanDisplayStatus, LoanStatus } from "../../src/business/entities/loan.entity.js";
import { Department } from "../../src/business/entities/employee.entity.js";
import { EquipmentStatus, EquipmentType } from "../../src/business/entities/equipment.entity.js";
import { DomainErrorCode } from "../../src/business/entities/errors.entity.js";
import { actorFrom, Role, UserStatus } from "../../src/business/entities/user.entity.js";
import { createSystemClock } from "../../src/business/rules/clock.rules.js";
import {
  daysBetween,
  isIsoDate,
  isoDateInTimeZone,
} from "../../src/business/rules/dates.rules.js";
import {
  normalizeEquipmentCode,
  normalizeEquipmentType,
} from "../../src/business/rules/equipment.rules.js";
import { uuidv7 } from "../../src/business/rules/id.rules.js";
import { loanDisplayStatus } from "../../src/business/rules/loans.rules.js";
import { authorize, can, Permission } from "../../src/business/rules/permissions.rules.js";
import {
  createScryptPasswordHasher,
  generateSessionToken,
  hashSessionToken,
} from "../../src/business/rules/security.rules.js";
import {
  DEFAULT_SESSION_POLICY,
  nextExpiry,
} from "../../src/business/rules/session.rules.js";
import {
  parseCredentials,
  parseEmployeeInput,
  parseEquipmentInput,
  parseInvitation,
  parseLoanInput,
  parseRegistration,
} from "../../src/business/rules/validation.rules.js";
import { expectDomainError } from "../support/expect-domain-error.js";

const manager = actorFrom({ id: "u1", role: Role.Manager, employeeId: null });
const employee = actorFrom({ id: "u2", role: Role.Employee, employeeId: "e1" });
const attempt = (fn: () => unknown) => Promise.resolve().then(fn);

describe("identificadores", () => {
  it("genera UUID v7 válidos y ordenados por tiempo", () => {
    const first = uuidv7(1_000);
    const second = uuidv7(2_000);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first < second).toBe(true);
  });
});

describe("equipos", () => {
  it("normaliza el tipo al valor del catálogo, sin importar mayúsculas ni tildes", () => {
    expect(normalizeEquipmentType("  laPTOP ")).toBe(EquipmentType.Laptop);
    expect(normalizeEquipmentType("periferico")).toBe(EquipmentType.Peripheral);
    expect(normalizeEquipmentType("PERIFÉRICO")).toBe(EquipmentType.Peripheral);
    expect(normalizeEquipmentType("Impresora")).toBeNull();
  });

  it("normaliza el código a mayúsculas", () => {
    expect(normalizeEquipmentCode("  lap-001 ")).toBe("LAP-001");
  });
});

describe("fechas", () => {
  it("acepta solo fechas de calendario reales", () => {
    expect(isIsoDate("2026-10-07")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("07/10/2026")).toBe(false);
  });

  it("cuenta días de calendario", () => {
    expect(daysBetween("2026-10-07", "2026-10-10")).toBe(3);
    expect(daysBetween("2026-10-07", "2026-10-06")).toBe(-1);
  });

  it("el reloj del sistema da la fecha de hoy en la zona indicada", () => {
    const clock = createSystemClock("UTC");
    expect(clock.now()).toBeInstanceOf(Date);
    expect(clock.today()).toBe(new Date().toISOString().slice(0, 10));
    expect(isIsoDate(createSystemClock().today())).toBe(true);
  });

  it("calcula hoy en la zona horaria de la empresa", () => {
    // 02:00 UTC del 8 es todavía el 7 en Santo Domingo (UTC-4).
    const date = new Date("2026-10-08T02:00:00Z");
    expect(isoDateInTimeZone(date, "America/Santo_Domingo")).toBe("2026-10-07");
    expect(isoDateInTimeZone(date, "UTC")).toBe("2026-10-08");
  });
});

describe("valores de estado (contrato con el frontend)", () => {
  it("coinciden con los textos que consume el frontend", () => {
    expect(Object.values(EquipmentStatus)).toEqual(["available", "loaned"]);
    expect(Object.values(LoanStatus)).toEqual(["active", "returned"]);
    expect(Object.values(LoanDisplayStatus)).toEqual([
      "active",
      "due_soon",
      "overdue",
      "returned",
    ]);
    expect(Object.values(UserStatus)).toEqual(["active", "inactive", "invited"]);
  });
});

describe("catálogos (contrato con el frontend)", () => {
  it("coinciden con los valores que consume el frontend", () => {
    expect(Object.values(EquipmentType)).toEqual(["Laptop", "Monitor", "Periférico", "Tablet"]);
    expect(Object.values(Department)).toEqual([
      "Finanzas",
      "Ventas",
      "Operaciones",
      "Tecnología",
      "Recursos Humanos",
    ]);
    expect(Object.values(Permission)).toEqual([
      "equipment:read",
      "equipment:write",
      "employees:read",
      "employees:write",
      "loans:read",
      "loans:write",
      "accounts:read",
      "accounts:write",
      "dashboard:read",
    ]);
    expect(Object.values(DomainErrorCode)).toEqual([
      "VALIDATION",
      "CONFLICT",
      "NOT_FOUND",
      "UNAUTHENTICATED",
      "FORBIDDEN",
    ]);
  });
});

describe("estado derivado del préstamo", () => {
  const today = "2026-10-07";
  const active = (dueOn: string) => ({ status: LoanStatus.Active, dueOn });

  it("deriva Activo, Por vencer (0 a 3 días) y Atrasado", () => {
    expect(loanDisplayStatus(active("2026-10-11"), today)).toBe(LoanDisplayStatus.Active);
    expect(loanDisplayStatus(active("2026-10-10"), today)).toBe(LoanDisplayStatus.DueSoon);
    expect(loanDisplayStatus(active("2026-10-07"), today)).toBe(LoanDisplayStatus.DueSoon);
    expect(loanDisplayStatus(active("2026-10-06"), today)).toBe(LoanDisplayStatus.Overdue);
  });

  it("un préstamo devuelto siempre es Devuelto, aunque haya vencido", () => {
    expect(
      loanDisplayStatus({ status: LoanStatus.Returned, dueOn: "2026-09-01" }, today),
    ).toBe(LoanDisplayStatus.Returned);
  });
});

describe("RBAC", () => {
  it("Encargado tiene todos los permisos", () => {
    expect(can(manager, Permission.AccountsWrite)).toBe(true);
    expect(can(manager, Permission.LoansWrite)).toBe(true);
  });

  it("Empleado solo consulta catálogo, préstamos y dashboard", () => {
    expect(can(employee, Permission.EquipmentRead)).toBe(true);
    expect(can(employee, Permission.LoansRead)).toBe(true);
    expect(can(employee, Permission.DashboardRead)).toBe(true);
    expect(can(employee, Permission.EquipmentWrite)).toBe(false);
    expect(can(employee, Permission.EmployeesRead)).toBe(false);
    expect(can(employee, Permission.AccountsRead)).toBe(false);
  });

  it("authorize lanza FORBIDDEN", async () => {
    await expectDomainError(
      attempt(() => authorize(employee, Permission.LoansWrite)),
      { code: DomainErrorCode.Forbidden, message: "No tienes permiso para realizar esta acción." },
    );
  });
});

describe("sesiones", () => {
  it("el token es aleatorio y solo se guarda su hash", () => {
    const token = generateSessionToken();
    expect(token).not.toBe(generateSessionToken());
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).not.toBe(token);
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it("la expiración se desliza sin pasar el tope absoluto", () => {
    const created = new Date("2026-10-07T08:00:00Z");
    const later = new Date("2026-10-07T09:00:00Z");
    expect(nextExpiry(created, later, DEFAULT_SESSION_POLICY).toISOString()).toBe(
      "2026-10-07T09:30:00.000Z",
    );
    const nearCap = new Date("2026-10-07T19:50:00Z");
    expect(nextExpiry(created, nearCap, DEFAULT_SESSION_POLICY).toISOString()).toBe(
      "2026-10-07T20:00:00.000Z",
    );
  });
});

describe("contraseñas (scrypt)", () => {
  // Costo bajo solo para que el test sea rápido.
  const hasher = createScryptPasswordHasher({ N: 1024, r: 8, p: 1 });

  it("verifica la contraseña correcta y rechaza las demás", async () => {
    const hash = await hasher.hash("Demo2026!");
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(hash).not.toContain("Demo2026!");
    expect(await hasher.verify("Demo2026!", hash)).toBe(true);
    expect(await hasher.verify("demo2026!", hash)).toBe(false);
  });

  it("usa una sal distinta en cada hash", async () => {
    expect(await hasher.hash("igual")).not.toBe(await hasher.hash("igual"));
  });

  it("rechaza hashes con formato inválido sin lanzar", async () => {
    expect(await hasher.verify("x", "")).toBe(false);
    expect(await hasher.verify("x", "bcrypt$10$abc")).toBe(false);
    expect(await hasher.verify("x", "scrypt$0$8$1$c2FsdA$aGFzaA")).toBe(false);
    expect(await hasher.verify("x", "scrypt$1024$8$1$c2FsdA$aGFzaA")).toBe(false);
  });

  it("trata un costo que scrypt no acepta como credencial inválida", async () => {
    const [, , , , salt, key] = (await hasher.hash("Demo2026!")).split("$");
    const withCost = (n: string, r: string, p: string) =>
      ["scrypt", n, r, p, salt, key].join("$");

    expect(await hasher.verify("Demo2026!", withCost("3", "8", "1"))).toBe(false);
    expect(await hasher.verify("Demo2026!", withCost("1", "8", "1"))).toBe(false);
    expect(await hasher.verify("Demo2026!", withCost("1.5", "8", "1"))).toBe(false);
    expect(await hasher.verify("Demo2026!", withCost(String(2 ** 40), "8", "1"))).toBe(false);
    expect(await hasher.verify("Demo2026!", withCost("1024", "1000000", "1"))).toBe(false);
    expect(await hasher.verify("Demo2026!", withCost("1024", "8", "1000"))).toBe(false);
  });

  it("no acepta configurarse con un costo no soportado", () => {
    expect(() => createScryptPasswordHasher({ N: 3, r: 8, p: 1 })).toThrow();
    expect(() => createScryptPasswordHasher({ N: 2 ** 22, r: 8, p: 1 })).toThrow();
    expect(() => createScryptPasswordHasher()).not.toThrow();
  });
});

describe("validación con los mensajes del frontend", () => {
  it("equipo: campos obligatorios, tipo y longitudes", async () => {
    await expectDomainError(
      attempt(() => parseEquipmentInput({ code: " ", name: "", type: "Impresora", model: "x".repeat(81) })),
      {
        code: DomainErrorCode.Validation,
        message: "Revisa los campos indicados.",
        fields: {
          code: "El código es obligatorio.",
          name: "El nombre es obligatorio.",
          type: "Selecciona un tipo de equipo.",
          model: "Máximo 80 caracteres.",
        },
      },
    );
  });

  it("equipo: normaliza los datos válidos", () => {
    expect(
      parseEquipmentInput({ code: "mon-02", name: " Dell  U2723 ", type: "monitor" }),
    ).toEqual({ code: "MON-02", name: "Dell U2723", type: EquipmentType.Monitor, brand: "", model: "" });
  });

  it("empleado: cédula, departamento y teléfono", async () => {
    await expectDomainError(
      attempt(() =>
        parseEmployeeInput({
          firstName: "Ana",
          lastName: "",
          identity: "00112345671",
          department: "Marketing",
          phone: "8095551234",
        }),
      ),
      {
        code: DomainErrorCode.Validation,
        fields: {
          lastName: "El apellido es obligatorio.",
          identity: "Usa el formato 000-0000000-0.",
          department: "Selecciona un departamento.",
          phone: "Usa el formato 809-000-0000.",
        },
      },
    );
    expect(
      parseEmployeeInput({
        firstName: "Ana",
        lastName: "García",
        identity: "001-1234567-1",
        department: Department.Technology,
      }).phone,
    ).toBe("");
  });

  it("préstamo: referencias y fecha válida", async () => {
    await expectDomainError(
      attempt(() => parseLoanInput({ employeeId: "", equipmentId: "", dueOn: "2026-13-01" })),
      {
        code: DomainErrorCode.Validation,
        fields: {
          employeeId: "El empleado es obligatorio.",
          equipmentId: "El equipo es obligatorio.",
          dueOn: "Selecciona una fecha válida.",
        },
      },
    );
  });

  it("credenciales: correo en minúsculas y contraseña obligatoria", async () => {
    expect(parseCredentials({ email: " Ana.Garcia@Empresa.com ", password: "x" }).email).toBe(
      "ana.garcia@empresa.com",
    );
    await expectDomainError(
      attempt(() => parseCredentials({ email: "no-es-correo", password: "" })),
      {
        code: DomainErrorCode.Validation,
        fields: {
          email: "Introduce un correo válido.",
          password: "La contraseña es obligatoria.",
        },
      },
    );
  });

  it("registro: mínimo y máximo de contraseña", async () => {
    await expectDomainError(
      attempt(() => parseRegistration({ name: "Ana", email: "a@b.co", password: "corta" })),
      { code: DomainErrorCode.Validation, fields: { password: "Usa al menos 8 caracteres." } },
    );
    await expectDomainError(
      attempt(() => parseRegistration({ name: "Ana", email: "a@b.co", password: "x".repeat(129) })),
      { code: DomainErrorCode.Validation, fields: { password: "Usa como máximo 128 caracteres." } },
    );
  });

  it("invitación: rol válido y empleado opcional", async () => {
    expect(parseInvitation({ email: "x@empresa.com", role: Role.Employee, employeeId: " " })).toEqual({
      email: "x@empresa.com",
      role: Role.Employee,
      employeeId: null,
    });
    await expectDomainError(
      attempt(() => parseInvitation({ email: "x@empresa.com", role: "Admin" })),
      { code: DomainErrorCode.Validation, fields: { role: "Selecciona un rol." } },
    );
  });
});
