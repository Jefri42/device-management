import { createAccountUseCases } from "./accounts.use-case.js";
import { createAuthUseCases } from "./auth.use-case.js";
import { createDashboardUseCases } from "./dashboard.use-case.js";
import type { UseCaseDeps } from "./deps.use-case.js";
import { createEmployeeUseCases } from "./employees.use-case.js";
import { createEquipmentUseCases } from "./equipment.use-case.js";
import { createLoanUseCases } from "./loans.use-case.js";

export function createUseCases(deps: UseCaseDeps) {
  return {
    auth: createAuthUseCases(deps),
    accounts: createAccountUseCases(deps),
    equipment: createEquipmentUseCases(deps),
    employees: createEmployeeUseCases(deps),
    loans: createLoanUseCases(deps),
    dashboard: createDashboardUseCases(deps),
  };
}

export type UseCases = ReturnType<typeof createUseCases>;
export type { UseCaseDeps } from "./deps.use-case.js";
