const ts = require('typescript');
const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2];
if (!inputFile) {
    console.error('Usage: node index.js <unresolved_calls.json>');
    process.exit(1);
}

const unresolvedCalls = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

// Collect source files from unresolved calls
const sourceFiles = [...new Set(unresolvedCalls.map(c => c.fromFile).filter(Boolean))];

// Create tsconfig-like compiler options
const compilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    strict: false,
    noEmit: true,
    allowJs: true,
    jsx: ts.JsxEmit.React,
};

// Try to find tsconfig.json in repo root for better resolution
let program;
const repoRoot = process.argv[3] || process.cwd();
const tsConfigPath = path.join(repoRoot, 'tsconfig.json');
if (fs.existsSync(tsConfigPath)) {
    const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
    if (!configFile.error) {
        const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
        program = ts.createProgram(sourceFiles, parsed.options);
    }
}

if (!program) {
    program = ts.createProgram(sourceFiles, compilerOptions);
}

const checker = program.getTypeChecker();
const resolved = [];

function findCallAtLine(sourceFile, lineNumber) {
    function visit(node) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
        if (line === lineNumber && ts.isCallExpression(node)) return node;
        return ts.forEachChild(node, visit);
    }
    return visit(sourceFile);
}

function getContainingClass(node) {
    let current = node.parent;
    while (current) {
        if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return current;
        current = current.parent;
    }
    return null;
}

for (const call of unresolvedCalls) {
    try {
        const sourceFile = program.getSourceFile(call.fromFile);
        if (!sourceFile) continue;

        const lineNumber = (call.line || 1) - 1;
        const callNode = findCallAtLine(sourceFile, lineNumber);
        if (!callNode) continue;

        const expr = ts.isCallExpression(callNode) ? callNode.expression : callNode;
        const symbol = checker.getSymbolAtLocation(expr);
        if (!symbol) continue;

        const declarations = symbol.getDeclarations() || [];
        for (const decl of declarations) {
            const targetFile = decl.getSourceFile().fileName;
            const targetClass = getContainingClass(decl)?.name?.text || '';
            const targetMethod = symbol.getName();

            // Skip node_modules
            if (targetFile.includes('node_modules')) continue;

            resolved.push({
                ...call,
                toFile: targetFile,
                toClass: targetClass,
                toMethod: targetMethod,
                resolvedBy: 'ts_semantic'
            });
            break;
        }
    } catch (err) {
        // Skip on any per-call error
    }
}

console.log(JSON.stringify(resolved));
