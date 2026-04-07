# repo-tools

CLI para detectar, respaldar, restaurar y observar partidas de R.E.P.O.

## Probar localmente en desarrollo

Requisitos:
- Node.js 18 o superior
- Windows con acceso a la carpeta de saves de R.E.P.O.

Ejecutar directo desde el repo:

```powershell
node .\src\cli.js
```

Ejecutar usando el script de npm:

```powershell
npm start
```

Verificar el paquete antes de publicar:

```powershell
npm pack
```

Luego probar el tarball generado de forma cercana a `npx`:

```powershell
npx .\tacuchi-repo-tools-1.0.0.tgz
```

## Uso publicado

```powershell
npx @tacuchi/repo-tools
```
