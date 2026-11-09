// Restricted Windows runner: esbuild is invoked directly by PowerShell before
// these tests. Inject only those real compiler outputs; keep the renderer real.
import { registerHooks } from 'node:module'
const parents = new Set(['../client-adapter/brand.mjs', '../client-adapter/desktop-runtime.mjs'].map(p => new URL(p, import.meta.url).href))
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'esbuild' && parents.has(context.parentURL)) return { url: new URL('./fixtures/prebuilt-esbuild.mjs', import.meta.url).href, shortCircuit: true }
  return nextResolve(specifier, context)
} })
