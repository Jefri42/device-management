import type { PublicUser } from "../entities/user.entity.js";

export interface AccountNotifier {
  invitationCreated(user: PublicUser): Promise<void>;
  passwordRecoveryRequested(user: PublicUser): Promise<void>;
}
