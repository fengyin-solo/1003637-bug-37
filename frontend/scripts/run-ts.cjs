/**
 * 极简 TS→CJS 转译运行器（esbuild 二进制在当前环境不可用，用 typescript API 兜底）。
 * 用法：node scripts/run-ts.cjs <entry.ts>
 * 把入口及其相对依赖逐个 transpile 到临时目录，改写相对 import 的 .cjs 后缀后运行。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const ts = require('typescript')

const entry = path.resolve(process.argv[2])
const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tsrun-'))
const visited = new Set()

function transpileFile(file) {
  if (visited.has(file)) return
  visited.add(file)
  const source = fs.readFileSync(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: file,
  })
  const rel = path.relative(path.resolve(__dirname, '..'), file).replace(/\.ts$/, '.cjs')
  const outPath = path.join(outRoot, rel)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  // 改写相对 require，加上 .cjs
  const fixed = outputText.replace(/require\("(\.[^"]+)"\)/g, (m, spec) => {
    if (/\.(cjs|json)$/.test(spec)) return m
    return `require("${spec}.cjs")`
  })
  fs.writeFileSync(outPath, fixed)

  // 继续处理相对依赖
  const importRe = /from\s+['"](\.[^'"]+)['"]|require\(['"](\.[^'"]+)['"]\)/g
  let match
  const content = source
  while ((match = importRe.exec(content))) {
    const spec = match[1] || match[2]
    if (/\.(json|css|vue)$/.test(spec)) continue
    const depPath = path.resolve(path.dirname(file), spec.endsWith('.ts') ? spec : `${spec}.ts`)
    if (fs.existsSync(depPath)) transpileFile(depPath)
  }
}

transpileFile(entry)
const entryOut = path.join(
  outRoot,
  path.relative(path.resolve(__dirname, '..'), entry).replace(/\.ts$/, '.cjs'),
)
require(entryOut)
