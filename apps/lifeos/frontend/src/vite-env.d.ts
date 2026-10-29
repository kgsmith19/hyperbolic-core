/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PLATFORM_URL: string;
  readonly VITE_PLATFORM_ANON_KEY: string;
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
