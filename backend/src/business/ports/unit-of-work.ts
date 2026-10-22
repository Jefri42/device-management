import type { Repositories } from "./repositories.js";

export interface UnitOfWork {
  readonly repositories: Repositories;
  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
