import { describe, expect, it } from "vitest";
import { Department } from "../../src/business/entities/employee.entity.js";
import { EquipmentStatus, EquipmentType } from "../../src/business/entities/equipment.entity.js";
import { DomainErrorCode } from "../../src/business/entities/errors.entity.js";
import { expectDomainError } from "../support/expect-domain-error.js";
import { setup } from "../support/setup.js";

const laptop = {
  code: "lap-010",
  name: "ThinkPad X1",
  type: "laptop ",
  brand: "Lenovo",
  model: "Gen 12",
};

describe("CU-01 registrar equipo", () => {
  it("registra el equipo Disponible con código y tipo normalizados", async () => {
    const { useCases, manager, uow } = setup();
    const equipment = await useCases.equipment.registerEquipment(manager, laptop);
    expect(equipment).toMatchObject({
      code: "LAP-010",
      name: "ThinkPad X1",
      type: EquipmentType.Laptop,
      status: EquipmentStatus.Available,
    });
    expect(equipment.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(uow.store.equipment.get(equipment.id)?.code).toBe("LAP-010");
  });

  it("3a: rechaza datos inválidos sin guardar nada", async () => {
    const { useCases, manager, uow } = setup();
    await expectDomainError(
      useCases.equipment.registerEquipment(manager, { code: "", name: "", type: "" }),
      {
        code: DomainErrorCode.Validation,
        fields: {
          code: "El código es obligatorio.",
          name: "El nombre es obligatorio.",
          type: "Selecciona un tipo de equipo.",
        },
      },
    );
    expect(uow.store.equipment.size).toBe(0);
  });

  it("3b: rechaza un código repetido aunque cambien las mayúsculas", async () => {
    const { useCases, manager, addEquipment } = setup();
    addEquipment({ code: "LAP-010" });
    await expectDomainError(useCases.equipment.registerEquipment(manager, laptop), {
      code: DomainErrorCode.Conflict,
      fields: { code: "Ya existe un equipo con ese código de activo." },
    });
  });

  it("un Empleado no puede registrar equipos", async () => {
    const { useCases, employee } = setup();
    await expectDomainError(useCases.equipment.registerEquipment(employee, laptop), {
      code: DomainErrorCode.Forbidden,
    });
  });
});

describe("CU-05 consultar equipos disponibles e inventario", () => {
  it("lista solo los equipos disponibles para ambos roles", async () => {
    const { useCases, manager, employee, addEquipment } = setup();
    const available = addEquipment();
    addEquipment({ status: EquipmentStatus.Loaned });
    for (const actor of [manager, employee]) {
      const result = await useCases.equipment.listAvailableEquipment(actor);
      expect(result.map((item) => item.id)).toEqual([available.id]);
    }
  });

  it("el Encargado ve todo el inventario y puede filtrar por estado", async () => {
    const { useCases, manager, addEquipment } = setup();
    addEquipment();
    const loaned = addEquipment({ status: EquipmentStatus.Loaned });
    expect(await useCases.equipment.listEquipment(manager)).toHaveLength(2);
    const filtered = await useCases.equipment.listEquipment(manager, { status: EquipmentStatus.Loaned });
    expect(filtered.map((item) => item.id)).toEqual([loaned.id]);
  });

  it("el Empleado nunca ve equipos prestados en el inventario", async () => {
    const { useCases, employee, addEquipment } = setup();
    addEquipment();
    addEquipment({ status: EquipmentStatus.Loaned });
    expect(await useCases.equipment.listEquipment(employee)).toHaveLength(1);
    expect(
      await useCases.equipment.listEquipment(employee, { status: EquipmentStatus.Loaned }),
    ).toEqual([]);
  });
});

describe("CU-02 registrar empleado", () => {
  const carlos = {
    firstName: " Carlos ",
    lastName: "Ruiz",
    identity: "402-1234567-8",
    department: Department.Sales,
    phone: "809-555-0101",
  };

  it("registra el empleado activo", async () => {
    const { useCases, manager } = setup();
    const employee = await useCases.employees.registerEmployee(manager, carlos);
    expect(employee).toMatchObject({
      firstName: "Carlos",
      lastName: "Ruiz",
      identity: "402-1234567-8",
      department: Department.Sales,
      phone: "809-555-0101",
      active: true,
    });
  });

  it("3a: rechaza datos inválidos", async () => {
    const { useCases, manager } = setup();
    await expectDomainError(
      useCases.employees.registerEmployee(manager, { ...carlos, identity: "123", department: "" }),
      {
        code: DomainErrorCode.Validation,
        fields: {
          identity: "Usa el formato 000-0000000-0.",
          department: "Selecciona un departamento.",
        },
      },
    );
  });

  it("3b: rechaza una cédula repetida e indica a quién pertenece", async () => {
    const { useCases, manager, ana } = setup();
    await expectDomainError(
      useCases.employees.registerEmployee(manager, { ...carlos, identity: ana.identity }),
      {
        code: DomainErrorCode.Conflict,
        fields: { identity: "Ya existe un empleado con esta cédula (Ana García)." },
      },
    );
  });

  it("solo el Encargado registra y consulta empleados", async () => {
    const { useCases, manager, employee } = setup();
    await expectDomainError(useCases.employees.registerEmployee(employee, carlos), {
      code: DomainErrorCode.Forbidden,
    });
    await expectDomainError(useCases.employees.listEmployees(employee), {
      code: DomainErrorCode.Forbidden,
    });
    expect(await useCases.employees.listEmployees(manager)).toHaveLength(1);
  });
});
