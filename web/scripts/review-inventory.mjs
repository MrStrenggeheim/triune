// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";

const web = fileURLToPath(new URL("../", import.meta.url));
const repo = path.dirname(path.resolve(web));
const relative = (file) => path.relative(repo, file).split(path.sep).join("/");
const axes = new Set(["variant", "size", "density", "disabled", "loading"]);
const unique = (values) => [...new Set(values)].sort();
const coverage = [
  "Source inventory of web/src TypeScript and TSX, including internal definitions, independent of bundle reachability. Stories, tests, fixtures and Storybook support files are evidence only.",
  "Named function and class declarations, arrow/function bindings, and React memo/forwardRef bindings are discovered by JSX use, React return type, wrapper or render method. Anonymous factories, runtime registries, lazy targets and createElement calls can require manual tracing.",
  "Production calls are JSX opening tags. TypeScript resolves imports, re-exports, namespace tags, simple aliases and React.lazy literal imports selecting a named or default export. Native DOM/SVG and external tags are counted separately. Other dynamic tags retain locations. Platform-native views outside web/src are outside this inventory.",
  "Props preserve source order. Literals, constant scalar aliases and conditional alternatives are static evidence. Spreads and other expressions retain source excerpts and positions. Children are not evaluated.",
  "State axes include finite locally declared literal unions and booleans, plus variant, size, density, loading and disabled from component APIs. Inherited DOM attributes remain visible on calls. Used includes static conditional alternatives and omitted destructuring defaults. Indexed story evidence includes literals, defaults and simple literal-array maps. Axes are independent; runtime-only states require manual tracing.",
  "Story links match CSF source exports, JSX in same-file helpers, or a catalogued interaction for the named owner. Fixture paths come from referenced fixture/mock imports. Test links require JSX use. Indexed means present in the supplied index, without a render or owner approval claim.",
  "Unrepresented means no indexed static evidence was found. Conditional rendering, custom render functions, indirect production children, story decorators and runtime interactions may expose more states.",
];

function walk(node, visit) {
  if (visit(node) !== false)
    ts.forEachChild(node, (child) => {
      walk(child, visit);
    });
}

function unwrap(expression) {
  let node = expression;
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node))
  )
    node = node.expression;
  return node;
}

function location(node) {
  const file = node.getSourceFile();
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return { path: relative(file.fileName), line: line + 1, column: character + 1 };
}

function sourceKind(file) {
  if (/\.stories\.[cm]?[jt]sx?$/.test(file)) return "story";
  if (/\.(test|spec)\.[jt]sx?$|\/(?:__tests__|test)\/|\/test-setup\.ts$/.test(file)) return "test";
  if (/\/storybook\/|\/__fixtures__\/|fixtures?\.[jt]sx?$/i.test(file)) return "support";
  return "production";
}

function loadProgram() {
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(web, "tsconfig.app.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(d) {
        throw Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    },
  );
  if (config.errors.length)
    throw Error(
      ts.formatDiagnostics(config.errors, {
        getCurrentDirectory: () => web,
        getCanonicalFileName: (name) => name,
        getNewLine: () => "\n",
      }),
    );
  return ts.createProgram(config.fileNames, config.options);
}

function scalar(node) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (
    ts.isPrefixUnaryExpression(node) &&
    ts.isNumericLiteral(node.operand) &&
    node.operator === ts.SyntaxKind.MinusToken
  )
    return -Number(node.operand.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
}

function jsonLiteral(expr) {
  const node = unwrap(expr);
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map(jsonLiteral);
    return values.every((v) => v !== undefined) ? values : undefined;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const entries = [];
    for (const field of node.properties) {
      if (!ts.isPropertyAssignment(field) || ts.isComputedPropertyName(field.name)) return;
      const value = jsonLiteral(field.initializer);
      if (value === undefined) return;
      entries.push([field.name.text, value]);
    }
    return Object.fromEntries(entries);
  }
  return scalar(node);
}

function symbolAt(node, checker) {
  const sym = node && checker.getSymbolAtLocation(node);
  return sym?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
}

function initializer(node, checker) {
  const decl = symbolAt(node, checker)?.valueDeclaration;
  if (decl && ts.isVariableDeclaration(decl) && decl.parent.flags & ts.NodeFlags.Const)
    return decl.initializer;
}

function alternatives(expr, checker, depth = 0) {
  if (!expr || depth > 8) return;
  const node = unwrap(expr);
  const literal = scalar(node);
  if (literal !== undefined) return { values: [literal], evidence: "literal" };
  if (ts.isConditionalExpression(node)) {
    const yes = alternatives(node.whenTrue, checker, depth + 1);
    const no = alternatives(node.whenFalse, checker, depth + 1);
    if (yes && no)
      return { values: unique([...yes.values, ...no.values]), evidence: "conditional" };
  }
  if (!ts.isIdentifier(node)) return;
  const binding = initializer(node, checker);
  if (binding) return alternatives(binding, checker, depth + 1);
  const param = symbolAt(node, checker)?.valueDeclaration;
  if (!param || !ts.isParameter(param) || param.parent.parameters[0] !== param) return;
  const call = param.parent.parent;
  if (
    !ts.isCallExpression(call) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "map" ||
    call.arguments[0] !== param.parent
  )
    return;
  let array = unwrap(call.expression.expression);
  if (ts.isIdentifier(array)) array = unwrap(initializer(array, checker));
  if (array && ts.isArrayLiteralExpression(array)) {
    const values = array.elements.map(scalar);
    if (values.every((v) => v !== undefined))
      return { values: unique(values), evidence: "literal-array-map" };
  }
}

function prop(name, expr, checker) {
  if (!expr) return { name, kind: "literal", value: true };
  const simple = name === "..." ? undefined : jsonLiteral(expr);
  if (simple !== undefined) return { name, kind: "literal", value: simple };
  const source = expr.getText();
  return {
    name,
    kind: name === "..." ? "spread" : "expression",
    ...location(expr),
    expression: source.slice(0, 180),
    ...(source.length > 180 && { truncated: true }),
    ...alternatives(expr, checker),
  };
}

function attributes(tag, checker) {
  return tag.attributes.properties.map((attr) => {
    if (ts.isJsxSpreadAttribute(attr)) return prop("...", attr.expression, checker);
    const expr = attr.initializer;
    return prop(
      attr.name.getText(),
      expr && ts.isJsxExpression(expr) ? expr.expression : expr,
      checker,
    );
  });
}

function reactFunction(node, checker) {
  let expr = ts.isVariableDeclaration(node) ? unwrap(node.initializer) : node;
  const wrappers = [];
  while (expr && ts.isCallExpression(expr)) {
    const symbol = symbolAt(expr.expression, checker);
    if (
      !["memo", "forwardRef"].includes(symbol?.name) ||
      !symbol.declarations?.some((d) => /\/(@types\/)?react\//.test(d.getSourceFile().fileName))
    )
      break;
    wrappers.push(symbol.name);
    expr = unwrap(expr.arguments[0]);
  }
  if (expr && ts.isIdentifier(expr) && wrappers.length) {
    const decl = symbolAt(expr, checker)?.valueDeclaration;
    expr = decl && ts.isVariableDeclaration(decl) ? unwrap(decl.initializer) : decl;
  }
  return { expr, wrappers };
}

function bindingTarget(symbol, checker) {
  const decl = symbol?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !(decl.parent.flags & ts.NodeFlags.Const)) return;
  const expr = unwrap(decl.initializer);
  if (!expr) return;
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) return symbolAt(expr, checker);
  if (!ts.isCallExpression(expr)) return;
  const factory = symbolAt(expr.expression, checker);
  if (
    factory?.name !== "lazy" ||
    !factory.declarations?.some((d) => /\/(@types\/)?react\//.test(d.getSourceFile().fileName))
  )
    return;
  const loader = expr.arguments[0];
  if (!loader || !ts.isArrowFunction(loader)) return;
  const body = unwrap(loader.body);
  if (!ts.isCallExpression(body)) return;
  if (body.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const module = symbolAt(body.arguments[0], checker);
    const target = module && checker.getExportsOfModule(module).find((s) => s.name === "default");
    return target?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(target) : target;
  }
  const then = body.expression;
  if (
    !ts.isPropertyAccessExpression(then) ||
    then.name.text !== "then" ||
    !ts.isCallExpression(then.expression) ||
    then.expression.expression.kind !== ts.SyntaxKind.ImportKeyword
  )
    return;
  const select = body.arguments[0];
  if (select && ts.isArrowFunction(select))
    return symbolAt(objectProp(unwrap(select.body), "default"), checker);
}

function stateAxes(type, fn, checker, decl) {
  const result = {};
  const binding = fn?.parameters?.[0]?.name;
  const defaults = new Map();
  if (binding && ts.isObjectBindingPattern(binding)) {
    for (const element of binding.elements) {
      const value = scalar(unwrap(element.initializer));
      if (value !== undefined)
        defaults.set((element.propertyName ?? element.name).getText(), value);
    }
  }
  const shapes = type?.isUnion() ? type.types : type ? [type] : [];
  const fields = new Map();
  for (const shape of shapes)
    for (const field of shape.getProperties()) {
      if (!fields.has(field.name)) fields.set(field.name, []);
      fields.get(field.name).push(field);
    }
  for (const [name, symbols] of fields) {
    const declarations = symbols.flatMap((s) => s.declarations ?? []);
    const own = declarations.some((d) =>
      relative(d.getSourceFile().fileName).startsWith("web/src/"),
    );
    if (!own && !axes.has(name)) continue;
    if (
      !own &&
      declarations.some(
        (d) =>
          ts.isInterfaceDeclaration(d.parent) &&
          /(?:HTML|SVG|DOM)Attributes$/.test(d.parent.name.text),
      )
    )
      continue;
    const parts = symbols.flatMap((s) => {
      const field = checker.getTypeOfSymbolAtLocation(s, decl);
      return field.isUnion() ? field.types : [field];
    });
    const values = [];
    let finite = true;
    for (const p of parts) {
      if (p.isStringLiteral() || p.isNumberLiteral()) values.push(p.value);
      else if (p.flags & ts.TypeFlags.BooleanLiteral) values.push(p.intrinsicName === "true");
      else if (!(p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))) finite = false;
    }
    if (!axes.has(name) && !(finite && values.length)) continue;
    result[name] = {
      declared: unique(values),
      finite,
      optional:
        symbols.length < shapes.length ||
        symbols.some((s) => !!(s.flags & ts.SymbolFlags.Optional)),
      nullable: parts.some((p) => !!(p.flags & ts.TypeFlags.Null)),
      ...(defaults.has(name) && { default: defaults.get(name) }),
      used: [],
      represented: [],
    };
  }
  return result;
}

function valuesFor(props, name, axis, story) {
  // The last assignment wins. A later spread can replace an earlier literal.
  const field = props.findLast((p) => p.name === name || p.name === "...");
  if (!field) return Object.hasOwn(axis, "default") ? [axis.default] : [];
  if (field.kind === "literal")
    return field.value === null || typeof field.value !== "object" ? [field.value] : [];
  if (field.kind === "spread" || (story && field.evidence === "conditional")) return [];
  return field.values ?? [];
}

function objectProp(obj, name) {
  const field =
    obj &&
    ts.isObjectLiteralExpression(obj) &&
    obj.properties.find((p) => p.name?.getText() === name);
  return (
    field &&
    (field.initializer ??
      (ts.isShorthandPropertyAssignment(field)
        ? field.name
        : ts.isMethodDeclaration(field)
          ? field
          : undefined))
  );
}

export function buildInventory(index, program = loadProgram()) {
  const checker = program.getTypeChecker();
  const files = program
    .getSourceFiles()
    .filter((f) => !f.isDeclarationFile && relative(f.fileName).startsWith("web/src/"))
    .sort((a, b) => a.fileName.localeCompare(b.fileName, "en"));
  const components = [];
  const owners = new Map();
  const definitions = new Map();
  const ids = new Set();
  const jsx = [];
  const candidates = [];
  const jsxSymbols = new Set();
  const exportsByFile = new Map();
  for (const file of files) {
    const kind = sourceKind(relative(file.fileName));
    const mod = checker.getSymbolAtLocation(file);
    const exports = mod
      ? checker
          .getExportsOfModule(mod)
          .filter((s) => s.flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Alias))
      : [];
    exportsByFile.set(file, exports);
    walk(file, (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const symbol = symbolAt(node.tagName, checker);
        jsx.push({ node, symbol, kind });
        if (symbol) jsxSymbols.add(symbol);
      }
      if (
        kind === "production" &&
        (ts.isFunctionDeclaration(node) ||
          ts.isVariableDeclaration(node) ||
          ts.isClassDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        /^[A-Z]/.test(node.name.text)
      )
        candidates.push(node);
    });
  }
  for (const decl of candidates) {
    const symbol = symbolAt(decl.name, checker);
    if (!symbol || owners.has(symbol)) continue;
    const { expr, wrappers } = reactFunction(decl, checker);
    const cls =
      ts.isClassDeclaration(decl) &&
      decl.members.some((m) => ts.isMethodDeclaration(m) && m.name.getText() === "render");
    if (!wrappers.length && !cls && !(expr && ts.isFunctionLike(expr) && expr.body)) continue;
    const type = checker.getTypeAtLocation(decl.name);
    const sig = type.getCallSignatures()[0];
    if (!cls && !wrappers.length && !jsxSymbols.has(symbol)) {
      const returned = sig?.getReturnType();
      const parts = returned?.isUnion() ? returned.types : [returned];
      if (
        !parts.some((p) =>
          p?.symbol?.declarations?.some(
            (d) =>
              /\/(@types\/)?react\//.test(d.getSourceFile().fileName) &&
              ["Element", "ReactElement", "ReactPortal"].includes(p.symbol.name),
          ),
        )
      )
        continue;
    }
    const param = sig?.parameters[0] ?? type.getConstructSignatures()[0]?.parameters[0];
    const input = param && checker.getTypeOfSymbolAtLocation(param, decl);
    const loc = location(decl.name);
    const name = decl.name.text;
    const exported = exportsByFile
      .get(decl.getSourceFile())
      .filter((s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s) === symbol)
      .map((s) => s.name);
    const record = {
      id: loc.path + "#" + name,
      name,
      source: loc,
      exports: exported,
      wrappers,
      variants: stateAxes(input, expr, checker, decl),
      calls: [],
      stories: [],
      tests: [],
      fixtures: [],
    };
    if (ids.has(record.id)) record.id += "@" + loc.line + ":" + loc.column;
    ids.add(record.id);
    owners.set(symbol, record);
    definitions.set(decl, record);
    components.push(record);
  }

  function lookup(binding) {
    let symbol = binding;
    const seen = new Set();
    while (symbol && !seen.has(symbol)) {
      if (owners.has(symbol)) return owners.get(symbol);
      seen.add(symbol);
      symbol = bindingTarget(symbol, checker);
    }
  }
  const nativeTags = Object.create(null);
  const externalTags = Object.create(null);
  const unmatched = [];
  const testFixtureImports = new Map();
  for (const { node, symbol, kind } of jsx) {
    const component = lookup(symbol);
    const file = node.getSourceFile();
    if (kind === "test" && component) {
      component.tests.push(relative(file.fileName));
      if (!testFixtureImports.has(file))
        testFixtureImports.set(file, fixtureImportsFor(file, checker));
      const imports = testFixtureImports.get(file);
      if (imports.size)
        walk(node.attributes, (n) => {
          if (!ts.isIdentifier(n)) return;
          const fixture = imports.get(checker.getSymbolAtLocation(n));
          if (fixture) component.fixtures.push(fixture);
        });
    }
    if (kind !== "production") continue;
    const tag = node.tagName.getText();
    if (ts.isIdentifier(node.tagName) && /^[a-z]/.test(tag))
      nativeTags[tag] = (nativeTags[tag] ?? 0) + 1;
    else if (component) {
      const props = attributes(node, checker);
      let container = node.parent;
      while (container && !definitions.has(container)) container = container.parent;
      component.calls.push({
        ...location(node),
        caller: definitions.get(container)?.id ?? null,
        tag,
        props,
      });
      for (const [key, axis] of Object.entries(component.variants))
        axis.used.push(...valuesFor(props, key, axis, false));
    } else if (
      symbol?.declarations?.some((d) => d.getSourceFile().fileName.includes("/node_modules/"))
    ) {
      externalTags[tag] = (externalTags[tag] ?? 0) + 1;
    } else unmatched.push({ ...location(node), tag, props: attributes(node, checker) });
  }

  const catalogFile = path.join(repo, "design-system/triune/interactions.json");
  const catalogText = existsSync(catalogFile) ? readFileSync(catalogFile, "utf8") : "[]";
  const catalog = JSON.parse(catalogText).map((row) => ({
    ...row,
    component: components.find(
      (c) =>
        c.source.path === "web/src/" + row.owner &&
        c.exports.some((name) => name.toLowerCase() === path.parse(row.owner).name.toLowerCase()),
    ),
  }));
  for (const file of files.filter((f) => sourceKind(relative(f.fileName)) === "story")) {
    linkStories(file, checker, lookup, exportsByFile.get(file), index, catalog);
  }

  for (const c of components) {
    c.tests = unique(c.tests);
    c.fixtures = unique([...c.fixtures, ...c.stories.flatMap((s) => s.fixtures)]);
    for (const axis of Object.values(c.variants)) {
      axis.used = unique(axis.used);
      axis.represented = unique(axis.represented);
      axis.unrepresented = index
        ? unique([...axis.declared, ...axis.used]).filter((v) => !axis.represented.includes(v))
        : null;
    }
    c.reviewStatus = c.stories.some((s) => s.id)
      ? "indexed-story"
      : c.stories.length
        ? "source-story"
        : "needs-story";
  }
  const digest = createHash("sha256")
    .update(catalogText)
    .update(readFileSync(path.join(web, "tsconfig.app.json")));
  for (const f of files)
    digest.update(relative(f.fileName)).update("\0").update(f.text).update("\0");
  return {
    schemaVersion: 1,
    revision: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
      worktreeModified: !!execFileSync(
        "git",
        [
          "status",
          "--porcelain",
          "--",
          "web/src",
          "web/tsconfig.app.json",
          "design-system/triune/interactions.json",
        ],
        { cwd: repo, encoding: "utf8" },
      ).trim(),
      sourceSha256: digest.digest("hex"),
      typescript: ts.version,
    },
    storybookIndex: index
      ? {
          entries: index.size,
          sha256: createHash("sha256")
            .update(JSON.stringify([...index].sort(([a], [b]) => a.localeCompare(b, "en"))))
            .digest("hex"),
        }
      : null,
    coverage,
    queueOrder: "Descending production JSX call count, then qualified component ID.",
    reviewQueue: [...components]
      .sort((a, b) => b.calls.length - a.calls.length || a.id.localeCompare(b.id, "en"))
      .map((c) => c.id),
    components,
    unmatched,
    nativeTags,
    externalTags,
  };
}

function fixtureImportsFor(file, checker) {
  const fixtureImports = new Map();
  for (const stmt of file.statements.filter(ts.isImportDeclaration)) {
    const spec = stmt.moduleSpecifier.text.split("?")[0];
    if (!/(fixture|mock)/i.test(spec)) continue;
    walk(stmt.importClause ?? stmt, (n) => {
      if (!ts.isIdentifier(n)) return;
      const target = symbolAt(n, checker)?.valueDeclaration?.getSourceFile().fileName;
      const raw = spec.startsWith("@/")
        ? path.join(web, "src", spec.slice(2))
        : path.resolve(path.dirname(file.fileName), spec);
      const resolved = existsSync(raw) ? raw : target;
      if (resolved && relative(resolved).startsWith("web/src/"))
        fixtureImports.set(checker.getSymbolAtLocation(n), relative(resolved));
    });
  }
  return fixtureImports;
}

// A gallery can exercise several owners, while stories in the same file can exercise different owners.
function linkStories(file, checker, lookup, exports, index, catalog) {
  const exportedMeta = file.statements.find(ts.isExportAssignment);
  if (!exportedMeta) return;
  const object = (expr) => {
    const value = unwrap(expr);
    return value && ts.isIdentifier(value) ? unwrap(initializer(value, checker)) : value;
  };
  const meta = object(exportedMeta.expression);
  const subject = lookup(symbolAt(objectProp(meta, "component"), checker));
  const title = scalar(objectProp(meta, "title"));
  const pathname = relative(file.fileName);
  const fixtureImports = fixtureImportsFor(file, checker);
  for (const exp of exports) {
    if (exp.name === "default") continue;
    const declaration = exp.valueDeclaration;
    if (!declaration) continue;
    const story = object(declaration.initializer ?? declaration);
    if (!story || !(ts.isObjectLiteralExpression(story) || ts.isFunctionLike(story))) continue;
    const evidence = new Map();
    const fixtures = new Set();
    function record(owner, reason, props) {
      if (!owner) return;
      if (!evidence.has(owner)) evidence.set(owner, { reasons: new Set(), states: {} });
      const entry = evidence.get(owner);
      entry.reasons.add(reason);
      if (!props) return;
      for (const [key, axis] of Object.entries(owner.variants)) {
        const values = valuesFor(props, key, axis, true);
        if (values.length) entry.states[key] = unique([...(entry.states[key] ?? []), ...values]);
      }
    }
    const args = [];
    for (const container of [meta, story]) {
      const argNode = objectProp(container, "args");
      if (!argNode) continue;
      const fields = object(argNode);
      if (!fields || !ts.isObjectLiteralExpression(fields)) {
        args.push(prop("...", argNode, checker));
        continue;
      }
      for (const p of fields.properties) {
        if (ts.isSpreadAssignment(p)) args.push(prop("...", p.expression, checker));
        else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
          args.push(prop(p.name.text ?? p.name.getText(), p.initializer ?? p.name, checker));
      }
    }
    const customRender =
      ts.isFunctionLike(story) || objectProp(story, "render") || objectProp(meta, "render");
    record(subject, "meta.component", customRender ? undefined : args);
    for (const row of catalog) {
      if ("web/src/" + row.story === pathname + "#" + exp.name)
        record(row.component, "interaction-catalog");
    }
    const visited = new Set();
    function trace(node) {
      if (!node || visited.has(node) || ts.isTypeNode(node)) return;
      visited.add(node);
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        record(lookup(symbolAt(node.tagName, checker)), "jsx", attributes(node, checker));
      }
      if (ts.isIdentifier(node)) {
        const fixture = fixtureImports.get(checker.getSymbolAtLocation(node));
        if (fixture) fixtures.add(fixture);
        const d = symbolAt(node, checker)?.valueDeclaration;
        if (
          d &&
          d.getSourceFile() === file &&
          (ts.isFunctionDeclaration(d) || ts.isVariableDeclaration(d))
        )
          trace(d.body ?? d.initializer);
      }
      ts.forEachChild(node, trace);
    }
    trace(story);
    for (const field of ["render", "args", "decorators", "loaders"]) {
      if (field === "render" && (objectProp(story, field) || ts.isFunctionLike(story))) continue;
      trace(objectProp(meta, field));
    }
    const live = index?.get(pathname + "#" + exp.name);
    for (const [owner, { reasons, states }] of evidence) {
      owner.stories.push({
        path: pathname,
        export: exp.name,
        title: live?.title ?? title,
        id: live?.id ?? null,
        href: live ? "./?path=/story/" + live.id : null,
        evidence: [...reasons],
        states,
        fixtures: [...fixtures].sort(),
      });
      if (live)
        for (const [key, values] of Object.entries(states))
          owner.variants[key].represented.push(...values);
    }
  }
}

export function packet(inventory, query) {
  const matches = inventory.components.filter((c) => c.id === query || c.name === query);
  if (!matches.length) throw Error("Unknown component " + query);
  if (matches.length > 1)
    throw Error("Ambiguous component. Use a qualified ID:\n" + matches.map((c) => c.id).join("\n"));
  return {
    schemaVersion: inventory.schemaVersion,
    revision: inventory.revision,
    storybookIndex: inventory.storybookIndex,
    coverage: inventory.coverage,
    component: matches[0],
  };
}

async function loadIndex(source) {
  let raw;
  if (/^https?:\/\//.test(source)) {
    const response = await globalThis.fetch(source, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error("Storybook index HTTP " + response.status);
    raw = await response.text();
  } else raw = readFileSync(source, "utf8");
  const data = JSON.parse(raw);
  if (!data.entries || ![4, 5].includes(data.v))
    throw Error("Expected a Storybook v4 or v5 index.json");
  const entries = new Map();
  for (const entry of Object.values(data.entries)) {
    if (entry.type !== "story") continue;
    if (!entry.id || !entry.exportName || !entry.importPath)
      throw Error("Storybook entry lacks id, exportName or importPath");
    const sourcePath = path.posix.normalize(entry.importPath.replaceAll("\\", "/"));
    entries.set(
      (sourcePath.startsWith("web/") ? "" : "web/") + sourcePath + "#" + entry.exportName,
      entry,
    );
  }
  return entries;
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      inventory: { type: "string" },
      component: { type: "string" },
      "storybook-index": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "node web/scripts/review-inventory.mjs [--storybook-index URL_OR_FILE] [--out FILE]\nnode web/scripts/review-inventory.mjs --inventory FILE --component NAME_OR_PATH#NAME [--out FILE]",
    );
    return;
  }
  if (values.inventory && values["storybook-index"])
    throw Error("Supply --storybook-index when generating the inventory");
  const inventory = values.inventory
    ? JSON.parse(readFileSync(values.inventory, "utf8"))
    : buildInventory(values["storybook-index"] ? await loadIndex(values["storybook-index"]) : null);
  const json =
    JSON.stringify(values.component ? packet(inventory, values.component) : inventory, null, 2) +
    "\n";
  if (values.out) {
    mkdirSync(path.dirname(values.out), { recursive: true });
    writeFileSync(values.out, json);
  } else process.stdout.write(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
