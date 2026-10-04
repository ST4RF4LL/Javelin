import { createRequire } from "node:module";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);

// Use actual Bruno packages, never a hand-written approximation of its parser.
// BRUNO_APP_ASAR also permits offline validation against an installed Windows or
// Linux desktop build. Only bundled source is read; user data is never accessed.
export function loadOfficialBruno() {
  try {
    return { schema: require("@usebruno/schema"), filestore: require("@usebruno/filestore"), source: "installed @usebruno packages", cleanup() {} };
  } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  const asar = process.env.BRUNO_APP_ASAR ?? "/Applications/Bruno.app/Contents/Resources/app.asar";
  if (!existsSync(asar)) return null;
  const root = mkdtempSync(join(tmpdir(), "bruno-export-official-"));
  const fd = openSync(asar, "r");
  try {
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    const size = header.readUInt32LE(12);
    if (size > 64 * 1024 * 1024) throw new Error("Invalid Bruno ASAR header");
    const bytes = Buffer.alloc(size);
    readSync(fd, bytes, 0, bytes.length, 16);
    const tree = JSON.parse(bytes.toString());
    const base = 8 + header.readUInt32LE(4);
    const lookup = pathname => pathname.split("/").reduce((node, segment) => node?.files?.[segment], tree);
    const read = node => {
      if (!node || node.unpacked || node.link) throw new Error("Expected packed Bruno source file");
      const content = Buffer.alloc(node.size);
      readSync(fd, content, 0, node.size, base + Number(node.offset));
      if (node.integrity?.hash && createHash("sha256").update(content).digest("hex") !== node.integrity.hash) throw new Error("Bruno bundled source integrity mismatch");
      return content;
    };
    const copy = (node, destination) => {
      if (node.files) {
        mkdirSync(destination, { recursive: true });
        for (const [name, child] of Object.entries(node.files)) {
          if (name.includes("/") || name === "..") throw new Error("Invalid ASAR entry");
          copy(child, join(destination, name));
        }
      } else writeFileSync(destination, read(node));
    };
    const done = new Set();
    const packageAt = name => {
      if (done.has(name) || name.startsWith("@types/")) return;
      done.add(name);
      const source = lookup(`node_modules/${name}`);
      if (!source) throw new Error(`Bruno dependency missing: ${name}`);
      copy(source, join(root, "node_modules", name));
      const info = JSON.parse(read(source.files["package.json"]));
      for (const dependency of Object.keys(info.dependencies ?? {})) {
        if (!lookup(`node_modules/${name}/node_modules/${dependency}`)) packageAt(dependency);
      }
    };
    packageAt("@usebruno/schema");
    packageAt("@usebruno/filestore");
    const version = JSON.parse(read(lookup("package.json"))).version;
    return {
      schema: require(join(root, "node_modules/@usebruno/schema")),
      filestore: require(join(root, "node_modules/@usebruno/filestore")),
      source: `Bruno ${version} bundled official schema and filestore`,
      cleanup() { rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  finally { closeSync(fd); }
}
