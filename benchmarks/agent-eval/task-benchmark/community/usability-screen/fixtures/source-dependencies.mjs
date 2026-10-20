import { registerHooks } from 'node:module';

// Provider-free dependency wiring for the real repository worker entry. The
// production runner and all support modules resolve from their repository paths.
const runner = new URL('../run.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === runner && ['../dsh.mjs', '../prepare.mjs'].includes(specifier)) {
    return { shortCircuit: true, url: new URL('./runtime-fixtures.mjs', import.meta.url).href };
  }
  return nextResolve(specifier, context);
} });
