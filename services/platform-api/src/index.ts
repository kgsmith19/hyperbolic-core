// Entry point: open the database, apply migrations, serve (#508).

import { migrate, openDatabase } from "@hyperbolic/sqlite-kit";

import { Auth } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { Signer } from "./jwt.ts";
import { syncRegistry } from "./registry.ts";
import { createPlatformServer } from "./server.ts";

const config = loadConfig();
const db = openDatabase(config.dbPath);
db.exec("pragma case_sensitive_like = on;");
const applied = migrate(db, config.migrationsDir);
const signer = new Signer(config.privateKeyPem);
const auth = new Auth(db, config, signer);
const registry = syncRegistry(db, config.registryRoot);
const server = createPlatformServer(db, config, auth, signer);
server.listen(config.port, config.host, () => {
  console.log(`platform-api: ${config.publicUrl} (db ${config.dbPath}${applied.length ? `, applied migrations ${applied.join(",")}` : ""}; registry ${registry.registered.length} apps${registry.retired.length ? `, retired ${registry.retired.join(",")}` : ""})`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => (db.close(), process.exit(0))));
}
