import { appendFile } from "node:fs/promises";
import { login, USER_A, USER_B } from "./helpers.mjs";

const environmentFile = process.env.GITHUB_ENV;
if (!environmentFile) throw new Error("GITHUB_ENV is required");

const tokenA = await login(USER_A);
const tokenB = await login(USER_B);
if (tokenA.includes("\n") || tokenB.includes("\n")) throw new Error("invalid test token");

await appendFile(
  environmentFile,
  `TOOLBELT_TEST_TOKEN_A=${tokenA}\nTOOLBELT_TEST_TOKEN_B=${tokenB}\n` +
    `PROMPT_TEST_TOKEN_A=${tokenA}\nPROMPT_TEST_TOKEN_B=${tokenB}\n`,
  { mode: 0o600 },
);
