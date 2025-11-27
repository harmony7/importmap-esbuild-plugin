# importmap-esbuild-plugin

An [esbuild](https://esbuild.github.io) plugin that applies an [import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap) during bundling, with optional support for resolving imports over HTTP(S).

It lets you:

- Use `"imports"` mappings (bare specifiers + prefix mappings) during an esbuild build.
- Optionally fetch modules over HTTP(S) when an import-map entry points at a URL.
- (advanced) Customize the loader used for HTTP(S) responses via a `loaderResolver` hook.

## Why?

esbuild does not natively support import maps. If you want to use browser-style import maps in your build pipeline, e.g. to override bare specifiers, redirect packages, or load modules from a CDN, you normally need custom resolution logic.

This plugin adds **import map semantics** to esbuild in a clean, declarative, and opt-in way to replace and redirect packages, allowing optional HTTP(S) fetching when enabled.

## Installation

```bash
npm install importmap-esbuild-plugin
```

## Basic usage

### 1. Import map for local files

```ts
import * as esbuild from "esbuild";
import { importMapEsbuildPlugin } from "importmap-esbuild-plugin";

await esbuild.build({
  entryPoints: ["./src/index.js"],
  bundle: true,
  format: "esm",
  outfile: "dist/bundle.js",
  plugins: [
    importMapEsbuildPlugin({
      importMap: {
        imports: {
          // exact match
          "lodash": "./vendor/lodash-shim.js",
          // prefix match
          "utils/": "./src/utils/",
        },
      },
      baseDir: process.cwd(),
    }),
  ],
});
```

This will:

- Map `import "lodash"` to `./vendor/lodash-shim.js`.
- Map anything under `utils/*` to their equivalent path under `./src/utils/*`.
   - e.g., map `import "utils/foo.js"` to `./src/utils/foo.js`.

Modules may be mapped to absolute or relative paths.

- If a module is mapped to a relative path, then the path is resolved relative to the specified `baseDir` value. If one is not specified, then it uses the [`absWorkingDir`](https://esbuild.github.io/api/#working-directory) value if one is provided to esbuild, or `process.cwd()` otherwise.

Relative-path imports and imports that are not mapped are left alone:

- `import "react"` is left to esbuild's normal resolver, resolving to the appropriate module according to normal resolution rules (e.g., from `node_modules`).
- `import "./foo"`, `import "../bar"` is also left to esbuild's normal resolver, resolving to the appropriate module (e.g., relative to the loading file).

These rules occur recursively - e.g., whenever an imported module attempts to resolve a bare specifier import, the import map is consulted.

### 2. Import map for HTTP(S) imports

HTTP support is **opt-in**. If you want an import map entry to point to a URL, you must set the `enableHttp` option to `true`.

```ts
importMapEsbuildPlugin({
  importMap: {
    imports: {
      "foo": "https://foo.com/a.js",
      "bar/": "https://bar.com/",
    },
  },
  enableHttp: true,
});
```

Example usage in source:

```js
import { a } from "foo";
import { b } from "bar/src/index.js";

console.log(a);
console.log(b);
```

This will:

- Map `import "foo"` to `https://foo.com/a.js`.
- Map anything under `bar/*` to their equivalent path under `https://bar.com/*`.
    - e.g., map `import "bar/src/index.js"` to `https://bar.com/src/index.js`.

When a module is resolved to an HTTP(S) URL: 

- The plugin fetches the module via HTTP (e.g., `https://example.com/a.js`) at build time.
- It determines the loader based on the file extension, falling back to content-type if no file extension is provided.
   - (advanced) This behavior is possible to override using `loaderResolver`.
- The fetched content and loader are used to bundle the result into your output.

These mappings occur recursively, i.e.:
- Whenever an imported module attempts to resolve a module, the import map is consulted.
- If a module loaded from an HTTP(S) URL imports another module referencing it by a relative path, then the plugin resolves the path relative to the calling URL and fetches the additional module via HTTP, e.g.:
   - If `https://foo.com/a.js` contains `import "./b.js"`, then the plugin fetches `https://foo.com/b.js`.

## Import map semantics

Supported features:

- Exact matches:
    - `"pkg"` matches `import "pkg"`
- Prefix matches:
    - `"pkg/"` matches `import "pkg/foo.js"`
    - longest prefix wins
- Scoped packages:
    - `@scope/pkg` and `@scope/pkg/` are treated the same as unscoped
- Non-mapped bare specifiers fall back to esbuild resolver
    - This may error if unresolved
- Relative imports are untouched and resolve relative to the importing file
    - If they are referenced from modules fetched via HTTP(S), then relative imports are resolved relative to that module

## HTTP module loading details

When resolving HTTP(S) targets with `enableHttp: true`:

1. Uses `fetch()` to retrieve the URL at build-time.
2. Deduplicates requests:
   - Same URL → single fetch & shared module instance
   - Different specifiers mapping to same URL → shared fetch
3. Resolves relative imports inside HTTP modules:
   ```js
   // https://example.com/mod.js
   import { b } from "./b.js"; // → https://example.com/b.js
   ```

4. Errors and timeouts:
    - Non-OK status throws
    - `timeoutMs` (default: 30_000) aborts requests

## Loader resolution and `loaderResolver`

Loader picking precedence:

1. `loaderResolver` return value
2. File extension in URL (`.js`, `.ts`, `.json`, `.css`, `.txt`, etc.)
3. `Content-Type` if available
4. If all else fails, a fallback value of `"js"` is used

### Example `loaderResolver`

```ts
loaderResolver: async (args, res) => {
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    return "json";
  }
  return null; // fall through to built-in rules
}
```

## Options reference

```ts
export interface ImportMap {
  imports?: Record<string, string>;
}

export interface ImportMapEsbuildPluginParams {
  importMap?: ImportMap;
  baseDir?: string;
  onLog?: (message: string) => void;
  timeoutMs?: number;
  loaderResolver?: LoaderResolver;
  enableHttp?: boolean;
}
```

## Limitations / roadmap

- No `"scopes"` support yet
- No URL-like keys inside import maps (only bare specifier keys supported for now)
- baseDir must be a local path and cannot currently be a URL
- Build-time only (not a runtime loader)

## License

[MIT](./LICENSE)
