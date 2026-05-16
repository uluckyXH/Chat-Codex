import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packagePath = path.resolve(__dirname, "../node_modules/@larksuiteoapi/node-sdk/package.json");

if (!fs.existsSync(packagePath)) {
  throw new Error(`Cannot patch bundled Lark SDK metadata: ${packagePath} does not exist.`);
}

const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
packageJson.dependencies = {
  ...packageJson.dependencies,
  axios: "^1.16.1",
};

fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
