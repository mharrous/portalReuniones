# Portal de Reuniones - C?mara de Ceuta

Portal interno de reuniones para la sala de reuniones de la C?mara de Comercio de Ceuta.

## Qu? contiene

- `worker.js`: c?digo completo del Cloudflare Worker del portal de reuniones.
- `dock/`: scripts del dock flotante del mini PC de la sala.

## Worker definitivo

- URL buena: https://reuniones.camaraceuta.workers.dev/
- Worker en Cloudflare: `reuniones`

## Importante sobre Cloudflare KV

Este Worker necesita una vinculaci?n KV llamada exactamente:

```txt
MEETINGS_KV
```

Ah? se guardan las reuniones y el estado del dock.

## Despliegue manual seguro

Para actualizar el Worker sin tocar la configuraci?n KV:

1. Abre Cloudflare Workers.
2. Entra en el Worker `reuniones`.
3. Pulsa `Edit code`.
4. Selecciona todo con `Ctrl+A`.
5. Pega el contenido completo de `worker.js`.
6. Pulsa `Save and deploy`.

## Dock del mini PC

El dock actualizado est? en `dock/` y debe apuntar a:

```txt
https://reuniones.camaraceuta.workers.dev
```

Para ejecutarlo en el mini PC, usa:

```powershell
.\dock\iniciar-dock-reunion.bat
```

## Seguridad

No subas claves, tokens ni secretos al repositorio.

## Login

El portal usa exclusivamente la identidad Microsoft del portal central. `AUTH_SECRET` firma la cookie propia de Reuniones y `PORTAL_AUTH_DB` comprueba en cada sesión que el usuario continúa activo y autorizado.

`AUTH_SECRET` debe mantenerse como secreto de Cloudflare:

```powershell
$secret = "VALOR_AUTH_SECRET"
$secret | npx wrangler secret put AUTH_SECRET
npx wrangler deploy
```

Las APIs del dock (`/api-dock` y `/api-meeting`) quedan fuera del login para que el control flotante del mini PC siga funcionando.

## Acceso desde el portal central

La tarjeta de Reuniones en `portal.camaraceuta.workers.dev` genera un código aleatorio de un solo uso, válido durante 45 segundos y vinculado a la aplicación `reuniones`. El Worker consume el código de forma atómica en `/api/auth/portal`, comprueba el usuario y su permiso en `portal-camara-auth` y crea una cookie propia.

La entrada directa sin sesión redirige al portal central. Si Microsoft ya mantiene la sesión corporativa, el regreso a Reuniones es automático. Las sesiones vuelven a comprobar en la D1 central que el usuario sigue activo y conserva el permiso.
