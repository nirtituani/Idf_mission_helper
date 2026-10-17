// Lets Node tests import browser modules that use the server path "/core/…" (→ src/core/…).
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('/core/')) return next(pathToFileURL(path.join(root, 'src', specifier)).href, context);
    return next(specifier, context);
  },
});
