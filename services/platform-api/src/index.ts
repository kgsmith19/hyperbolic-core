// Entry point: open the database, apply migrations, serve (#508).

import { migrate, openDatabase } from "@hyperbolic/sqlite-kit";

import { Auth } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { Signer } from "./jwt.ts";
import { createPlatformServer } from "./server.ts";

const config = loadConfig();
const db = openDatabase(config.dbPath);
db.exec("pragma case_sensitive_like = on;");
const applied = migrate(db, config.migrationsDir);
const signer = new Signer(config.privateKeyPem);
const auth = new Auth(db, config, signer);
const server = createPlatformServer(db, config, auth, signer);
server.listen(config.port, config.host, () => {
  console.log(`platform-api: ${config.publicUrl} (db ${config.dbPath}${applied.length ? `, applied migrations ${applied.join(",")}` : ""})`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => (db.close(), process.exit(0))));
}
