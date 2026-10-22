import { describe, expect, it } from "vitest";
import { DomainErrorCode } from "../../src/business/entities/errors.entity.js";
import { Role, UserStatus } from "../../src/business/entities/user.entity.js";
import { hashSessionToken } from "../../src/business/rules/security.rules.js";
import { expectDomainError } from "../support/expect-domain-error.js";
import { DEMO_PASSWORD, setup } from "../support/setup.js";

const MINUTE = 60_000;

describe("registro público", () => {
  it("crea una cuenta Empleado activa, sin vínculo, y abre sesión", async () => {
    const { useCases, uow } = setup();
    const result = await useCases.auth.register({
      name: "Diego Torres",
      email: " Diego.Torres@Empresa.com ",
      password: "secreta123",
    });
    expect(result.user).toMatchObject({
      name: "Diego Torres",
      email: "diego.torres@empresa.com",
      role: Role.Employee,
      status: UserStatus.Active,
      employeeId: null,
    });
    expect("passwordHash" in result.user).toBe(false);
    expect(uow.store.users.get(result.user.id)?.passwordHash).toBe("hashed:secreta123");
    expect(uow.store.sessions.has(result.token)).toBe(false);
    expect(uow.store.sessions.get(hashSessionToken(result.token))?.userId).toBe(result.user.id);
  });

  it("rechaza un correo ya registrado y datos inválidos", async () => {
    const { useCases } = setup();
    await expectDomainError(
      useCases.auth.register({ name: "Otra", email: "ANA.GARCIA@empresa.com", password: "secreta123" }),
      { code: DomainErrorCode.Conflict, fields: { email: "Ya existe una cuenta con este correo." } },
    );
    await expectDomainError(
      useCases.auth.register({ name: "", email: "x", password: "123" }),
      {
        code: DomainErrorCode.Validation,
        fields: {
          name: "El nombre es obligatorio.",
          email: "Introduce un correo válido.",
          password: "Usa al menos 8 caracteres.",
        },
      },
    );
  });
});

describe("login", () => {
  it("abre una sesión para credenciales válidas", async () => {
    const { useCases, employeeUser } = setup();
    const result = await useCases.auth.login({
      email: "Ana.Garcia@empresa.com",
      password: DEMO_PASSWORD,
    });
    expect(result.user.id).toBe(employeeUser.id);
    expect(result.session.expiresAt.toISOString()).toBe("2026-10-07T12:30:00.000Z");
  });

  it("usa el mismo error para contraseña incorrecta, correo inexistente o cuenta no activa", async () => {
    const { useCases, addUser, passwordHasher } = setup();
    addUser({ email: "invitado@empresa.com", status: UserStatus.Invited, passwordHash: null });
    addUser({ email: "inactivo@empresa.com", status: UserStatus.Inactive });
    const expected = {
      code: DomainErrorCode.Unauthenticated,
      message: "Correo o contraseña incorrectos.",
      fields: { password: "Correo o contraseña incorrectos." },
    };
    await expectDomainError(
      useCases.auth.login({ email: "ana.garcia@empresa.com", password: "otra" }),
      expected,
    );
    for (const email of ["nadie@empresa.com", "invitado@empresa.com", "inactivo@empresa.com"])
      await expectDomainError(useCases.auth.login({ email, password: DEMO_PASSWORD }), expected);
    // Hash aunque la cuenta no exista: el tiempo de respuesta no revela si el correo existe.
    expect(passwordHasher.calls.hash).toBe(3);
  });

  it("regenera la sesión: el token previo del navegador deja de valer", async () => {
    const { useCases } = setup();
    const first = await useCases.auth.login({ email: "ana.garcia@empresa.com", password: DEMO_PASSWORD });
    const second = await useCases.auth.login(
      { email: "ana.garcia@empresa.com", password: DEMO_PASSWORD },
      { currentToken: first.token },
    );
    expect(second.token).not.toBe(first.token);
    await expectDomainError(useCases.auth.getCurrentSession(first.token), {
      code: DomainErrorCode.Unauthenticated,
    });
    expect((await useCases.auth.getCurrentSession(second.token)).user.email).toBe(
      "ana.garcia@empresa.com",
    );
  });
});

describe("sesión actual", () => {
  const login = async () => {
    const context = setup();
    const { token } = await context.useCases.auth.login({
      email: "laura.mendez@empresa.com",
      password: DEMO_PASSWORD,
    });
    return { ...context, token };
  };

  it("devuelve el usuario y el actor para los demás casos de uso", async () => {
    const { useCases, token, managerUser } = await login();
    const current = await useCases.auth.getCurrentSession(token);
    expect(current.actor).toEqual({ userId: managerUser.id, role: Role.Manager, employeeId: null });
    expect(current.user.email).toBe("laura.mendez@empresa.com");
  });

  it("rechaza tokens ausentes o desconocidos", async () => {
    const { useCases } = await login();
    await expectDomainError(useCases.auth.getCurrentSession(undefined), {
      code: DomainErrorCode.Unauthenticated,
      message: "Inicia sesión para continuar.",
    });
    await expectDomainError(useCases.auth.getCurrentSession("inventado"), {
      code: DomainErrorCode.Unauthenticated,
    });
  });

  it("vence tras 30 minutos sin actividad y se borra", async () => {
    const { useCases, token, clock, uow } = await login();
    clock.advance(30 * MINUTE);
    await expectDomainError(useCases.auth.getCurrentSession(token), {
      code: DomainErrorCode.Unauthenticated,
      message: "Tu sesión expiró. Inicia sesión de nuevo.",
    });
    expect(uow.store.sessions.size).toBe(0);
  });

  it("la actividad extiende la sesión (expiración deslizante)", async () => {
    const { useCases, token, clock } = await login();
    clock.advance(20 * MINUTE);
    const touched = await useCases.auth.getCurrentSession(token);
    expect(touched.session.expiresAt.toISOString()).toBe("2026-10-07T12:50:00.000Z");
    clock.advance(25 * MINUTE);
    await useCases.auth.getCurrentSession(token);
  });

  it("no reescribe la sesión más de una vez por minuto", async () => {
    const { useCases, token, clock, uow } = await login();
    const writes: string[] = [];
    uow.beforeWrite = (operation) => writes.push(operation);
    clock.advance(30_000);
    await useCases.auth.getCurrentSession(token);
    expect(writes).toEqual([]);
    clock.advance(30_000);
    await useCases.auth.getCurrentSession(token);
    expect(writes).toEqual(["sessions.touch"]);
  });

  it("una renovación con hora anterior no hace retroceder la sesión", async () => {
    const { useCases, token, clock, uow } = await login();
    const id = hashSessionToken(token);
    clock.advance(5 * MINUTE);
    const { session } = await useCases.auth.getCurrentSession(token);
    const older = (date: Date) => new Date(date.getTime() - 1_000);
    await uow.repositories.sessions.touch(id, older(session.lastSeenAt), older(session.expiresAt));
    expect(uow.store.sessions.get(id)?.lastSeenAt.getTime()).toBe(session.lastSeenAt.getTime());
    expect(uow.store.sessions.get(id)?.expiresAt.getTime()).toBe(session.expiresAt.getTime());

    await useCases.auth.logout(token);
    await uow.repositories.sessions.touch(id, clock.now(), clock.now());
    expect(uow.store.sessions.has(id)).toBe(false);
  });

  it("vence a las 12 horas aunque haya actividad continua", async () => {
    const { useCases, token, clock } = await login();
    for (let elapsed = 0; elapsed < 12 * 60; elapsed += 20) {
      await useCases.auth.getCurrentSession(token);
      clock.advance(20 * MINUTE);
    }
    await expectDomainError(useCases.auth.getCurrentSession(token), {
      code: DomainErrorCode.Unauthenticated,
    });
  });

  it("deja de valer si la cuenta se desactiva", async () => {
    const { useCases, token, uow, managerUser } = await login();
    const row = uow.store.users.get(managerUser.id);
    if (row) row.status = UserStatus.Inactive;
    await expectDomainError(useCases.auth.getCurrentSession(token), {
      code: DomainErrorCode.Unauthenticated,
    });
  });

  it("acepta una política de sesión distinta", async () => {
    const context = setup({
      sessionPolicy: { idleTimeoutMs: 5 * MINUTE, absoluteTimeoutMs: 60 * MINUTE, touchIntervalMs: MINUTE },
    });
    const { token } = await context.useCases.auth.login({
      email: "laura.mendez@empresa.com",
      password: DEMO_PASSWORD,
    });
    context.clock.advance(5 * MINUTE);
    await expectDomainError(context.useCases.auth.getCurrentSession(token), {
      code: DomainErrorCode.Unauthenticated,
    });
  });
});

describe("logout y recuperación", () => {
  it("logout borra la sesión y es idempotente", async () => {
    const { useCases, uow } = setup();
    const { token } = await useCases.auth.login({ email: "ana.garcia@empresa.com", password: DEMO_PASSWORD });
    await useCases.auth.logout(token);
    await useCases.auth.logout(token);
    await useCases.auth.logout(undefined);
    expect(uow.store.sessions.size).toBe(0);
  });

  it("la recuperación responde igual exista o no la cuenta y solo avisa a cuentas activas", async () => {
    const { useCases, notifier, addUser } = setup();
    addUser({ email: "inactivo@empresa.com", status: UserStatus.Inactive });
    await useCases.auth.requestPasswordRecovery("Ana.Garcia@empresa.com");
    await useCases.auth.requestPasswordRecovery("nadie@empresa.com");
    await useCases.auth.requestPasswordRecovery("inactivo@empresa.com");
    expect(notifier.events.map((event) => [event.type, event.user.email])).toEqual([
      ["recovery", "ana.garcia@empresa.com"],
    ]);
    await expectDomainError(useCases.auth.requestPasswordRecovery("no-es-correo"), {
      code: DomainErrorCode.Validation,
      fields: { email: "Introduce un correo válido." },
    });
  });
});
