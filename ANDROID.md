# 📱 Subvid Android App

Subvid es una aplicación completa para Android que permite transcribir audio y video con IA (Whisper), traducir subtítulos (NLLB), editar en una línea de tiempo interactiva y exportar videos con subtítulos incrustados o archivos `.srt`, todo ejecutándose **100% de forma local en tu dispositivo** sin enviar datos a servidores externos.

---

## 🏗️ Arquitectura Android

- **Contenedor:** [Capacitor 8](https://capacitorjs.com) (`@capacitor/android`)
- **Frontend:** Astro 6 + Tailwind CSS 4 compilado en modo estático autónomo (`output: 'static'`)
- **IA Local:** Whisper ASR + NLLB-200 ejecutándose en Web Workers con WebAssembly (WASM), WebGPU y caché persistente en IndexedDB
- **Exportación:** Mediabunny + WebCodecs / MediaRecorder con soporte nativo de Web Share API en Android
- **Permisos Optimizados:** Acceso a multimedia (`READ_MEDIA_VIDEO`, `READ_MEDIA_AUDIO`), almacenamiento externo, aceleración por hardware y `largeHeap` habilitado para procesamiento de modelos de IA en memoria.

---

## ☁️ Compilación en la Nube con GitHub Actions (CI/CD)

No necesitas compilar Android Studio ni el SDK de Android en tu teléfono. El repositorio incluye workflows automatizados de GitHub Actions:

### 1. Workflow CI/CD (`.github/workflows/android-ci.yml`)
- Se ejecuta automáticamente en cada `push` o `pull_request` a las ramas `main` y `android-app`, o manualmente vía `workflow_dispatch`.
- Pasos automatizados:
  1. Instala dependencias con `pnpm` y compila el frontend web estático (`pnpm run build:android`).
  2. Sincroniza los assets web con el proyecto Android nativo (`npx cap sync android`).
  3. Configura Java 21 y Android SDK en Ubuntu en la nube.
  4. Genera automáticamente las claves de firma (Keystore).
  5. Compila **Debug APK** (`subvid-debug.apk`), **Release APK firmado** (`subvid-release.apk`) y **Android App Bundle** (`subvid-release.aab`).
  6. Sube los ejecutables compilados a la sección **Artifacts** de la ejecución de GitHub Actions para descarga inmediata.

### 2. Workflow de Releases (`.github/workflows/android-release.yml`)
- Se activa al crear una etiqueta Git (`v1.0.0`, `v0.1.0`, etc.) o manualmente.
- Genera la versión firmada y publica automáticamente un **GitHub Release** con los archivos `.apk` y `.aab` listos para instalar o subir a Google Play.

---

## 🛠️ Comandos de Desarrollo Android

| Comando | Descripción |
| :--- | :--- |
| `pnpm run build:android` | Compila la aplicación web en modo estático para Android |
| `pnpm run android:sync` | Compila y sincroniza los assets web con el proyecto `android/` |
| `pnpm run android:copy` | Copia los assets web a la carpeta de assets de Android |
| `pnpm run android:open` | Abre el proyecto en Android Studio (en entorno de escritorio) |

---

## 📦 Configuración de Firma (Opcional para Producción)

Para firmar los APKs con tu propio certificado en GitHub Actions, agrega estos secretos en **Settings > Secrets and variables > Actions**:

- `ANDROID_KEYSTORE_BASE64`: Tu archivo `.jks` o `.keystore` codificado en base64 (`base64 -w 0 mi-keystore.jks`).
- `ANDROID_KEYSTORE_PASSWORD`: Contraseña del keystore.
- `ANDROID_KEY_ALIAS`: Alias de la clave.
- `ANDROID_KEY_PASSWORD`: Contraseña de la clave.

*(Si no configuras secretos, GitHub Actions genera automáticamente un keystore auto-firmado válido para que el APK sea 100% instalable de inmediato).*
