# LiveMarket MS Payments

## Propósito

`livemarket-ms-payments` es el microservicio de pagos de LiveMarket. Implementado
con Hono y desplegado como Cloudflare Worker, administra cuentas bancarias
simuladas en BOB, genera y valida códigos QR de pago, confirma pagos mediante
PIN y mantiene fondos en custodia (escrow) hasta su liquidación o reembolso.
También expone operaciones internas para expirar registros, procesar eventos
pendientes y avanzar el ciclo de vida de las custodias.

La persistencia y las operaciones transaccionales se realizan en Supabase. Las
reglas de negocio que se invocan como funciones RPC (por ejemplo,
`execute_qr_payment` y `resolve_escrow_dispute`) residen en la base de datos y
no están definidas en este repositorio; aquí se documenta el contrato y el orden
de invocación visibles en el servicio.

## Estructura del proyecto

```text
livemarket-ms-payments/
├── README.md                   # Propósito, configuración, endpoints y flujos
├── package.json                # Dependencias y comandos npm/pnpm
├── pnpm-lock.yaml              # Versiones exactas resueltas por pnpm
├── tsconfig.json               # Opciones de compilación TypeScript
├── wrangler.jsonc              # Configuración de Cloudflare Workers/Wrangler
└── src/
    ├── index.ts                # Aplicación Hono, middleware global y rutas raíz
    ├── middleware/
    │   └── auth.ts             # Verificación JWT y extracción del actor
    ├── routes/
    │   ├── bank.routes.ts      # Creación, consulta y recarga de cuentas simuladas
    │   ├── escrow.routes.ts    # QR de liquidación, consulta y resolución de escrow
    │   ├── internal.routes.ts  # Endpoints M2M, outbox, expiración y tareas escrow
    │   └── qr.routes.ts        # Generación, lectura y pago con QR
    ├── types/
    │   └── index.ts            # Tipos de entorno, actor y contexto Hono
    └── utils/
        └── supabase.ts         # Cliente admin y utilidades SHA-256/HMAC-SHA-256
```

### Responsabilidad por archivo

- **`src/index.ts`**: construye la aplicación Hono, aplica registro de
  solicitudes y CORS global, registra `/health` y monta los grupos `/api/bank`,
  `/api/qr`, `/api/internal` y `/api/escrow`. También define las respuestas
  comunes para rutas inexistentes y errores no controlados.
- **`src/middleware/auth.ts`**: lee el JWT del encabezado `Authorization`, lo
  valida con `JWT_SECRET` y algoritmo HS256 y requiere un `sub` de tipo string
  y un rol `B2C`, `B2B` o `DRIVER`. Guarda `id`, `role` y, si está presente,
  `store_id` en el contexto de la petición como `actor`.
- **`src/routes/bank.routes.ts`**: protege todas sus rutas con JWT y administra
  cuentas personales y saldo ficticio. El hash del PIN y la recarga se delegan
  a funciones RPC de Supabase.
- **`src/routes/qr.routes.ts`**: crea obligaciones y QR, permite consultar un
  QR mediante su token y confirmar el pago de una cuenta. Al confirmar un pago
  de orden, también crea el registro de escrow y envía un evento a MS4 en segundo
  plano.
- **`src/routes/escrow.routes.ts`**: asocia el QR de comprador o vendedor a una
  custodia, consulta el detalle de una orden y permite a un actor B2B solicitar
  la liquidación o reembolso.
- **`src/routes/internal.routes.ts`**: protege las tareas de servicio a servicio
  con `X-Internal-Key`. Ejecuta expiraciones y temporizadores, procesa eventos
  de outbox y automatiza liquidaciones vencidas.
- **`src/utils/supabase.ts`**: crea un cliente Supabase con la clave de servicio
  y define `sha256Hex` y `signHmacSha256` usando Web Crypto.
- **`src/types/index.ts`**: define las variables de entorno requeridas por el
  Worker y los tipos del actor y contexto de Hono.
- **`package.json`**: declara dependencias y scripts de desarrollo, despliegue y
  generación de tipos. No define un script de pruebas.
- **`pnpm-lock.yaml`**: fija el árbol de dependencias utilizado por pnpm.
- **`tsconfig.json`**: configura TypeScript estricto, módulos ES y tipos de
  Cloudflare Workers.
- **`wrangler.jsonc`**: establece `src/index.ts` como entrada y las opciones de
  compatibilidad y nombre del Worker.

## Requisitos y ejecución

- Node.js y pnpm.
- Un proyecto Supabase con las tablas y funciones RPC utilizadas por el
  servicio.
- Los bindings y secretos configurados en el entorno de Cloudflare Workers.

### Variables de entorno

| Variable | Uso |
|---|---|
| `SUPABASE_URL` | URL del proyecto Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave de servicio usada por el cliente admin de Supabase. |
| `JWT_SECRET` | Secreto HS256 para validar los JWT de usuario. |
| `PAYMENT_QR_SECRET` | Clave HMAC que firma los datos del QR generado. |
| `PAYMENTS_INTERNAL_KEY` | Clave compartida para proteger endpoints internos y autenticar el envío de eventos a MS4. |
| `MS4_URL` | URL base de MS4, destino del evento `PAYMENT_SUCCEEDED`. |
| `MS4_INTERNAL_KEY` | Declarada en el tipo de entorno, pero no utilizada por el código de este servicio. |
| `MS1_URL` | Declarada en el tipo de entorno, pero no utilizada por el código de este servicio (por el momento). |

## Convenciones de la API

- Las rutas funcionales llevan el prefijo `/api`; `/health` es la excepción.
- Las respuestas de negocio suelen usar `{ "success": true, "data": ... }` o
  `{ "success": false, "error": ... }`. Algunos errores de pago devuelven un
  campo `code` en lugar de `error`.
- Los endpoints protegidos por `auth` requieren un JWT válido con rol admitido.
  Los endpoints bajo `/api/internal` usan `X-Internal-Key` en lugar del JWT.
- Los esquemas JSON se validan con Zod donde se indica. Si la validación falla,
  Hono responde antes de ejecutar el handler.
- Los montos se manejan en BOB. En la creación de cuentas, el saldo inicial
  predeterminado es `100000`.

## Endpoints

### Salud

#### `GET /health`

No requiere autenticación. Devuelve el nombre del servicio, estado `ok` y hora
actual en ISO 8601. No consulta Supabase.

### Cuentas bancarias simuladas — `/api/bank`

Todas estas rutas requieren JWT.

#### `POST /api/bank/account`

Crea la cuenta bancaria simulada del actor autenticado.

**JSON**

| Campo | Tipo | Reglas |
|---|---|---|
| `account_holder` | string | 1–160 caracteres. |
| `account_number` | string | 6–20 caracteres. |
| `pin` | string | De 4 a 6 dígitos numéricos. |
| `initial_balance` | number | No negativo; opcional, predeterminado `100000`. |

**Algoritmo**

1. Valida el cuerpo y obtiene el `actor.id` del JWT.
2. Llama a la RPC `hash_pin` para que PostgreSQL genere el hash del PIN.
3. Inserta la cuenta en `bank_accounts`, asociada a `owner_user_id`, guarda el
   hash (no el PIN en claro) y fija la moneda en `BOB`.
4. Devuelve los campos públicos seleccionados, sin incluir `pin_hash`.

**Respuestas relevantes:** `201` al crear; `500` si falla el hash; `409` si
falla la inserción.

#### `GET /api/bank/account`

Busca la cuenta del actor por `owner_user_id` y devuelve id, número, titular,
saldo, moneda y estado de actividad. Responde `404` cuando no encuentra una
cuenta.

#### `POST /api/bank/account/topup`

Recarga el saldo ficticio.

**JSON:** `amount` positivo y `operation_key` con formato UUID.

**Algoritmo**

1. Busca la cuenta del actor.
2. Si no existe, responde `404`.
3. Llama a `credit_demo_balance` con el id de la cuenta, el monto y la clave de
   operación. La deduplicación/efecto transaccional depende de la implementación
   de esa RPC en Supabase.
4. Devuelve el resultado de la RPC; sus errores se responden con `400`.

#### `POST /api/bank/transfer-direct`

Transfiere saldo desde la cuenta del actor hacia otra cuenta bancaria simulada.

**JSON**

| Campo | Tipo | Reglas |
|---|---|---|
| `target_account_id` | string | UUID de la cuenta destino. |
| `amount` | number | Positivo. |
| `pin` | string | De 4 a 6 caracteres; la validación HTTP solo exige longitud. |

**Algoritmo**

1. Busca la cuenta origen asociada al actor autenticado; responde `404` si no existe.
2. Busca la cuenta destino por `id`; responde `404` si no existe.
3. Rechaza la transferencia si la cuenta origen y destino son la misma, con `400`.
4. Verifica que el saldo origen sea suficiente; si no, responde `400` con
   `Fondos insuficientes`.
5. Calcula los nuevos saldos, actualiza ambas cuentas y registra dos movimientos
   en `bank_transactions` (débito y crédito).
6. Devuelve `200` con el monto transferido, el saldo restante y la cuenta destino.

### Pagos QR — `/api/qr`

Todas estas rutas requieren JWT.

#### `POST /api/qr/generate`

Crea una obligación de pago y genera un token QR.

**JSON**

| Campo | Tipo | Reglas |
|---|---|---|
| `purpose` | string | `ORDER_PAYMENT` o `SUBSCRIPTION_UPGRADE`. |
| `reference_id` | string | UUID de la referencia (orden o entidad correspondiente). |
| `target_store_id` | string | UUID opcional. |
| `requested_plan` | string | Opcional: `PRO` o `ENTERPRISE`. |
| `amount` | number | Positivo. |
| `idempotency_key` | string | 8–200 caracteres. |
| `validity_type` | string | Opcional: `1_DAY`, `7_DAYS` o `INDEFINITE`; valor por defecto `INDEFINITE`. |

**Algoritmo**

1. Calcula la fecha de expiración: 1 día, 7 días o 10 años para
   `INDEFINITE`.
2. Intenta insertar un registro en `payments`, con moneda `BOB` y la clave de
   idempotencia.
3. Si la inserción falla, busca un pago con esa clave. Si no existe, responde
   `400`. Si existe, compara propósito, referencia, tienda, plan y monto:
   datos distintos producen `409`; si coinciden, reutiliza el pago existente.
4. Rechaza la generación si el pago ya tiene estado `PAID`.
5. Genera un token aleatorio con UUID y marca temporal. Calcula el SHA-256
   hexadecimal del token para almacenarlo y firma con HMAC-SHA-256 la cadena
   `payment_id:amount:raw_token` usando `PAYMENT_QR_SECRET`.
6. Marca como `CANCELLED` los QR `PENDING` anteriores de ese pago e inserta el
   nuevo QR con estado `PENDING`, hash, firma y expiración.
7. Devuelve el token original una sola vez en la respuesta, junto con los datos
   del pago. La base guarda el hash del token y la firma, no el token original.

**Respuestas relevantes:** `201` al generar; `400` ante error de inserción o
pago ya pagado; `409` si se reutiliza la clave con otros datos; `500` si falla
la inserción del QR.

#### `GET /api/qr/scan/:token`

Busca y presenta el detalle del QR para lectura desde la aplicación.

**Algoritmo**

1. Calcula SHA-256 del token recibido.
2. Busca ese hash en `payment_qrs` y obtiene datos asociados de `payments`.
3. Si no hay coincidencia, responde `404`.
4. Compara `expires_at` con la hora actual. Si venció, reporta `EXPIRED` en la
   respuesta; de lo contrario, devuelve el estado guardado del QR.
5. Devuelve datos del pago (propósito, referencia, monto y moneda). La lectura
   no actualiza el estado persistido del QR.

#### `POST /api/qr/pay`

Confirma un pago mediante el PIN de la cuenta del actor.

**JSON:** `qr_token` string y `pin` de 4–6 caracteres. La validación HTTP del
PIN limita longitud; la comprobación de PIN y el resto de reglas se delegan a
la RPC.

**Algoritmo**

1. Busca la cuenta bancaria del actor autenticado; responde `404` si no existe.
2. Calcula el SHA-256 del token recibido.
3. Invoca `execute_qr_payment` con hash del token, id de cuenta y PIN. La
   validación del PIN, vigencia/estado del QR, débito y transición del pago son
   responsabilidad de esta RPC en Supabase.
4. Si hay error RPC, responde `400`; si la RPC devuelve `success: false`,
   transmite su `code` con estado `400`.
5. Si el propósito es `ORDER_PAYMENT`, consulta `target_store_id` del pago e
   intenta insertar un escrow en estado `HELD`, con orden, cliente, monto y
   moneda. Un error de inserción se registra en consola; el handler continúa
   con la respuesta de pago.
6. Para `ORDER_PAYMENT`, envía en segundo plano a
   `POST {MS4_URL}/api/internal/payments/events` un evento `PAID` con id de
   evento, pago, orden, monto y moneda, autenticado con `X-Internal-Key`. La
   ejecución se agenda con `waitUntil`; un error de red se registra, sin cambiar
   la respuesta del pago.
7. Devuelve el resultado exitoso de la RPC.

### Custodia (escrow) — `/api/escrow`

Todas estas rutas requieren JWT.

#### `POST /api/escrow/bind-qr`

**JSON:** `order_id` UUID y `qr_image_url` URL válida.

Actualiza el QR de la custodia asociada a la orden. Si el actor es `B2B`, guarda
`seller_qr_image_url`; para los demás roles admitidos, guarda
`buyer_qr_image_url`. Devuelve id, orden, estado y ambas URLs. Responde `404`
si no se encuentra el registro. El handler no añade una comprobación explícita
de propiedad de la orden.

#### `GET /api/escrow/detail/:order_id`

Busca por `order_id` y devuelve el registro completo de `escrow_settlements`.
Responde `404` si no existe. El handler no filtra campos por rol.

#### `POST /api/escrow/settle`

Solo admite actores con rol `B2B`; los demás reciben `403`.

**JSON:** `order_id` UUID, `action` igual a `RELEASE_TO_SELLER` o
`REFUND_TO_BUYER` y `notes` opcional.

Invoca `resolve_escrow_dispute` con orden, acción y notas. Si no se indican
notas, usa `Liquidación procesada mediante QR bancario de destino`. Los errores
RPC o el resultado `success: false` se devuelven como `400`; el estado final y
las transferencias dependen de la función en base de datos.

### Operaciones internas — `/api/internal`

Todas las rutas requieren el encabezado `X-Internal-Key`, que debe coincidir
con `PAYMENTS_INTERNAL_KEY`. La comprobación ocurre antes de cada handler; una
clave ausente o incorrecta devuelve `401`. Estas rutas están destinadas a
llamadas de servicio a servicio o tareas programadas.

#### `POST /api/internal/expire`

Sin cuerpo. Ejecuta la RPC `expire_ms6_records` y devuelve sus datos. Los
errores de Supabase producen `500`. Qué tablas y estados expira se define en la
RPC.

#### `POST /api/internal/process-outbox`

Procesa un lote de eventos pendientes para entregarlos a MS4.

**Algoritmo**

1. Selecciona hasta 20 filas de `payment_outbox` con estado `PENDING` o
   `FAILED` y `next_retry_at` menor o igual a la hora actual.
2. Si la consulta falla, no devuelve filas o el lote está vacío, responde
   `{ success: true, processed: 0 }`.
3. Para cada evento con destino `MS4` y tipo `PAYMENT_SUCCEEDED`, hace POST de
   `payload` a `{MS4_URL}/api/internal/payments/events`, con JSON y
   `X-Internal-Key`.
4. Si MS4 responde 2xx, actualiza el evento a `SENT`, asigna `sent_at` y suma
   uno al contador.
5. Si falla la llamada HTTP, cambia el evento a `FAILED`, incrementa `attempts`,
   guarda el error y calcula el próximo intento con retroceso exponencial:
   `2^(attempts_nuevo) * 60 000 ms` desde la hora actual.
6. Devuelve `{ success: true, processed: N }`. Los eventos de otros destinos o
   tipos no tienen una rama de procesamiento en este handler.

#### `POST /api/internal/escrow/delivered`

**JSON:** requiere `order_id`; `timer_minutes` opcional, con valor por defecto
`5`.

Inicia el temporizador llamando a `start_escrow_timer` con la orden y los
minutos. Un cuerpo JSON inválido o sin `order_id` produce `400`. Los errores
RPC o `success: false` también producen `400`; el cálculo y la transición de
estado corresponden a la RPC.

#### `POST /api/internal/escrow/dispute`

**JSON:** requiere `order_id` y `action`; acepta `reason` opcional.

Invoca `resolve_escrow_dispute` con la orden y acción. Usa `reason` como nota o,
si está ausente, `Disputa reportada por el comprador`. Si falta alguno de los
campos requeridos responde `400`; también responde `400` ante error RPC o
`success: false`. Este endpoint no valida con Zod los formatos ni el catálogo
de valores de `action`; las restricciones adicionales corresponden a la RPC.

#### `POST /api/internal/escrow/process-settlements`

Procesa las custodias cuyo periodo de espera venció.

**Algoritmo**

1. Busca en `escrow_settlements` los registros `TIMING_OUT` con `release_due_at`
   anterior o igual a la hora actual.
2. Si hay error de consulta o no hay registros, responde
   `{ success: true, settled: 0 }`.
3. Para cada registro, invoca `resolve_escrow_dispute` con
   `RELEASE_TO_SELLER` y la nota `Liberación automática: periodo finalizado sin
   reclamos`.
4. Cuenta las RPC que devuelven `success: true` y responde
   `{ success: true, settled: N }`.

La liberación efectiva y las protecciones contra concurrencia o doble
liquidación dependen de la lógica transaccional de `resolve_escrow_dispute`.

## Algoritmos y flujos principales

### Idempotencia de la generación QR

La clave `idempotency_key` identifica el intento de crear el pago. Si ya existe,
el servicio compara los datos relevantes y reutiliza el pago solo cuando la
solicitud es equivalente. Si los datos difieren, rechaza la operación para
evitar asociar una clave a obligaciones distintas. Una misma obligación no
puede generar un QR nuevo desde este endpoint si el pago ya figura como `PAID`.

### Protección del token QR

El token se genera con un UUID y la hora actual. Para localizarlo se almacena
su SHA-256 hexadecimal. Además, el servicio calcula una firma HMAC-SHA-256 sobre
`payment_id:amount:raw_token`, usando `PAYMENT_QR_SECRET`. La firma se guarda en
la fila del QR; la validación final de pago se realiza en
`execute_qr_payment`, cuya implementación SQL no está incluida aquí.

### Custodia y notificación a MS4

Una confirmación exitosa de pago de orden intenta crear una custodia `HELD` y
notifica a MS4 de forma asíncrona. En paralelo, las rutas internas permiten
iniciar el temporizador y resolver disputas o liquidaciones. El outbox ofrece
otro mecanismo de entrega con reintentos exponenciales; el envío directo del
pago y el procesamiento del outbox son flujos separados.

## Dependencias externas y límites del repositorio

- **Supabase/PostgreSQL**: tablas consultadas o modificadas:
  `bank_accounts`, `payments`, `payment_qrs`, `escrow_settlements` y
  `payment_outbox`.
- **Funciones RPC requeridas**: `hash_pin`, `credit_demo_balance`,
  `execute_qr_payment`, `expire_ms6_records`, `start_escrow_timer` y
  `resolve_escrow_dispute`.
- **MS4**: recibe eventos en `/api/internal/payments/events`.
- Este repositorio no incluye las migraciones, definiciones SQL, políticas RLS
  ni la aplicación MS4. Los detalles internos de esas piezas deben verificarse
  en sus repositorios/configuraciones respectivos.