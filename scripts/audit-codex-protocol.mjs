import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ts from "typescript";

// Read only the method inventory and the field contracts consumed by this bridge.
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (!args.includes("--schema") || !args.includes("--baseline")) {
  throw new Error("Usage: node scripts/audit-codex-protocol.mjs --schema DIR --baseline FILE [--write --source DESCRIPTION]");
}
const schemaDir = option("--schema");
const baselinePath = option("--baseline");
const digest = crypto.createHash("sha256");
const printer = ts.createPrinter({ removeComments: true });
function declaration(file) {
  const absolute = path.join(schemaDir, `${file}.ts`);
  if (!fs.existsSync(absolute)) return undefined;
  const text = fs.readFileSync(absolute, "utf8");
  digest.update(file).update("\0").update(text);
  const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
  return { source, type: source.statements.find(ts.isTypeAliasDeclaration)?.type };
}
const normalized = (node, source) => printer.printNode(ts.EmitHint.Unspecified, node, source).replace(/\s+/g, " ").trim();
const nameOf = (node) => ts.isStringLiteral(node) ? node.text : node.getText();
const variants = (type) => ts.isUnionTypeNode(type) ? type.types : [type];
const methods = {};
for (const [direction, file] of Object.entries({ client_request: "ClientRequest", server_request: "ServerRequest", server_notification: "ServerNotification" })) {
  const parsed = declaration(file);
  if (!parsed?.type) throw new Error(`Missing required schema: ${file}`);
  methods[direction] = variants(parsed.type).map((variant) => {
    const method = variant.members?.find((member) => member.name && nameOf(member.name) === "method");
    return method?.type && ts.isLiteralTypeNode(method.type) && ts.isStringLiteral(method.type.literal) ? method.type.literal.text : undefined;
  }).filter(Boolean).sort();
  if (!methods[direction].length) throw new Error(`No methods parsed from ${file}`);
}
const contracts = {};
for (const file of ["MessagePhase", "v2/AgentMessageDelivery", "v2/AsyncUserInputQuestion", "v2/ToolRequestUserInputParams", "v2/Turn", "v2/TurnStatus", "v2/TurnError", "v2/ErrorNotification", "v2/ThreadGoalSetParams", "v2/ThreadGoalClearParams", "v2/ThreadResumeResponse", "v2/ThreadSettings", "v2/Model", "v2/CommandExecutionRequestApprovalParams", "v2/CurrentTimeReadParams", "v2/CurrentTimeReadResponse"]) {
  const parsed = declaration(file);
  contracts[file] = parsed?.type ? normalized(parsed.type, parsed.source) : null;
}
const item = declaration("v2/ThreadItem");
for (const kind of ["agentMessage", "imageGeneration"]) {
  const variant = item?.type && variants(item.type).find((node) => node.members?.some((member) => member.name && nameOf(member.name) === "type" && member.type && ts.isLiteralTypeNode(member.type) && member.type.literal.text === kind));
  contracts[`v2/ThreadItem.${kind}`] = variant ? normalized(variant, item.source) : null;
}
const snapshot = { source: args.includes("--source") ? option("--source") : schemaDir, capturedAt: "2026-10-15", sourceDigest: digest.digest("hex"), methods, contracts };
if (args.includes("--write")) {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`Wrote ${baselinePath}`);
} else {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const changes = [];
  for (const direction of Object.keys(methods)) {
    for (const method of methods[direction]) if (!baseline.methods[direction].includes(method)) changes.push(`added ${direction}: ${method}`);
    for (const method of baseline.methods[direction]) if (!methods[direction].includes(method)) changes.push(`removed ${direction}: ${method}`);
  }
  for (const key of Object.keys(contracts)) if (contracts[key] !== baseline.contracts[key]) changes.push(`changed contract: ${key}`);
  console.log(JSON.stringify({ baseline: baseline.source, changes }, null, 2));
  if (changes.length) process.exitCode = 1;
}
