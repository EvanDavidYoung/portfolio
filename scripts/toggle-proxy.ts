import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const configPath = path.resolve(__dirname, '../src/config.ts')
const proxyPath = path.resolve(__dirname, '../src/pages/api/proxy.ts')
const backupPath = path.resolve(__dirname, '../src/pages/api/proxy.ts.bak')
const astroConfigPath = path.resolve(__dirname, '../astro.config.ts')

const configContent = fs.readFileSync(configPath, 'utf-8')

const match = configContent.match(/linkCard:\s*(true|false)/)
if (!match) {
  console.error('linkCard config not found')
  process.exit(1)
}
const linkCardEnabled: boolean = match[1] === 'true'

function toggleAstroAdapter(comment: boolean) {
  const lines = fs.readFileSync(astroConfigPath, 'utf-8').split('\n')

  const importIndex = lines.findIndex(
    (line) => line.trim().includes('import') && line.includes('cloudflare')
  )
  const adapterIndex = lines.findIndex(
    (line) => line.trim().includes('adapter:') && line.includes('cloudflare')
  )

  if (importIndex === -1 || adapterIndex === -1) {
    console.error('Could not find cloudflare adapter import or configuration')
    return
  }

  if (comment) {
    if (!lines[importIndex].trim().startsWith('//')) lines[importIndex] = '// ' + lines[importIndex]
    if (!lines[adapterIndex].trim().startsWith('//')) lines[adapterIndex] = '// ' + lines[adapterIndex]
  } else {
    if (lines[importIndex].trim().startsWith('//')) lines[importIndex] = lines[importIndex].replace(/^\/\/\s?/, '')
    if (lines[adapterIndex].trim().startsWith('//')) lines[adapterIndex] = lines[adapterIndex].replace(/^\/\/\s?/, '')
  }

  fs.writeFileSync(astroConfigPath, lines.join('\n'), 'utf-8')
}

if (!linkCardEnabled) {
  if (fs.existsSync(proxyPath)) {
    fs.renameSync(proxyPath, backupPath)
    console.log('proxy.ts disabled')
  }
  toggleAstroAdapter(true)
  console.log('adapter config disabled')
} else {
  if (fs.existsSync(backupPath)) {
    fs.renameSync(backupPath, proxyPath)
    console.log('proxy.ts enabled')
  }
  toggleAstroAdapter(false)
  console.log('adapter config enabled')
}
