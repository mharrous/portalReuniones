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
