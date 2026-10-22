import type { IsoDate } from "../entities/loan.entity.js";

export interface Clock {
  now(): Date;
  today(): IsoDate;
}
