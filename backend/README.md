# Device Management — Backend

API REST del monolito. **Node.js 22, Express 5 y TypeScript estricto.** Convive con `../frontend` en el mismo repositorio y sirve en `http://localhost:8080/api`, la URL que el frontend espera en `NEXT_PUBLIC_API_BASE_URL`.

## Ejecutar en local

```sh
npm ci
cp .env.example .env
npm run dev      # tsx watch
npm run check    # lint + typecheck + tests
npm run build && npm start
```

## Arquitectura por capas

Según `Arquitectura.md`: cada capa solo conoce a la inmediata inferior y las dependencias van siempre hacia abajo.

```text
src/
  presentation/  Rutas, controladores, DTOs (zod) y middleware. Sin reglas de negocio ni queries
    routes/ controllers/ dto/ middleware/
  business/      Entidades, reglas, casos de uso y ports (contratos). Sin HTTP ni SQL
    entities/ rules/ use-cases/ ports/
  db/            Adaptadores que implementan los ports (repositorios)
    repositories/
  config/        Configuración y variables de entorno
  app.ts         Express (CORS, JSON, router)
  server.ts      Arranque
```

ESLint (`eslint.config.mts`) hace cumplir las dependencias: negocio no importa presentación, DB ni Express; presentación no importa DB; DB no importa HTTP ni casos de uso.

## Estado

- **Negocio (`src/business/`, issue #5): completo y probado con repositorios falsos.** Todavía no está conectado a HTTP ni a una base de datos.
- **Presentación (issue #6):** solo existe `GET /api/health`.
- **DB (issue #4):** pendiente. Debe implementar los ports de `business/ports/` con Prisma y MySQL.

## Lógica de negocio

`createUseCases(deps)` (`business/use-cases/index.ts`) devuelve todos los casos de uso. Las dependencias se inyectan: `UnitOfWork` (repositorios y transacciones), `Clock`, `PasswordHasher` y `AccountNotifier`. Cada caso de uso protegido recibe primero el `Actor` (usuario, rol y empleado vinculado), que presentación obtiene con `auth.getCurrentSession(token)`.

| Módulo | Casos de uso | Rol |
| --- | --- | --- |
| `equipment` | `registerEquipment` (CU-01), `listAvailableEquipment` (CU-05), `listEquipment` | Registrar: Encargado. Consultar: ambos; el Empleado solo ve los disponibles |
| `employees` | `registerEmployee` (CU-02), `listEmployees` | Encargado |
| `loans` | `createLoan` (CU-03), `returnLoan` (CU-04), `listLoans` (CU-06) | Registrar y devolver: Encargado. Consultar: ambos; el Empleado solo ve los suyos |
| `auth` | `register`, `login`, `logout`, `getCurrentSession`, `requestPasswordRecovery` | Público |
| `accounts` | `listAccounts`, `inviteAccount`, `deactivateAccount` | Encargado |
| `dashboard` | `getDashboard` | Ambos; el Empleado sin indicadores del inventario |

Reglas principales:

- **Errores:** `DomainError` con código `VALIDATION`, `CONFLICT`, `NOT_FOUND`, `UNAUTHENTICATED` o `FORBIDDEN`. El mensaje y `fields` están en español, con las mismas claves y textos que usa el frontend.
- **Identificadores:** UUID v7 generados en negocio.
- **Equipos:** el código se guarda en mayúsculas. El tipo se normaliza al catálogo del frontend (`Laptop`, `Monitor`, `Periférico`, `Tablet`) sin distinguir mayúsculas ni tildes; un tipo fuera del catálogo es un error de validación.
- **Préstamos:**
  - Estados guardados: `active` → `returned`. `due_soon` (0 a 3 días) y `overdue` se calculan con la fecha de hoy en `America/Santo_Domingo`.
  - Crear un préstamo y devolverlo son transacciones. Al crear se bloquea la fila del equipo (`findByIdForUpdate`) y se verifica que no tenga otro préstamo activo.
- **Sesiones:**
  - Token aleatorio de 256 bits; en la base de datos solo se guarda su hash SHA-256.
  - El login invalida la sesión previa del navegador (regeneración del id).
  - Contraseñas con scrypt (parámetros de OWASP). Mismo error y mismo costo para correo inexistente, contraseña incorrecta o cuenta no activa.
- **Cuentas:**
  - Invitar crea una cuenta `invited` sin contraseña.
  - Desactivar es una baja lógica: la cuenta pasa a `inactive`, su empleado se desactiva y sus sesiones se cierran. Sus préstamos activos se conservan (se devuelven con CU-04) y ya no puede recibir préstamos nuevos. No se puede desactivar la propia cuenta.

### Decisiones abiertas del issue #5 y valor tomado

| Decisión | Valor actual | Dónde cambiarlo |
| --- | --- | --- |
| Duración de la sesión | 30 min de inactividad, tope de 12 h | `DEFAULT_SESSION_POLICY` o `sessionPolicy` en `createUseCases` |
| ¿Todo empleado tiene cuenta? | No. Una cuenta puede no tener empleado y viceversa | — |
| ¿El Empleado solo ve sus préstamos? | Sí, como el frontend | `loanScope` en `use-cases/loans.use-case.ts` |
| ¿Estado "Vencido"? | No. Se usa `overdue`, derivado, como el frontend | `rules/loans.rules.ts` |
| Recuperación de contraseña | Solo avisa por `AccountNotifier`. Falta definir el proveedor de correo y dónde guardar el token de recuperación | — |

### Tests

`npm test` corre los tests de `tests/unit/` con vitest. Usan los ports falsos de `tests/support/in-memory.ts`, que aplican las restricciones únicas, serializan las transacciones y revierten si una falla. Así se prueban la atomicidad y los préstamos simultáneos sin base de datos.
