import { isAbsolute, resolve } from 'node:path';
import type { Loader, OnResolveResult, Plugin } from 'esbuild';

const PLUGIN_NAME = 'importmap-esbuild-plugin';

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

export type LoaderResolver = (
  args: { path: string, namespace: string, with: Record<string, string>, },
  res: Response,
) => (LoaderResolverResult | Promise<LoaderResolverResult>);

export type LoaderResolverResult = Loader | null | undefined;

export function importMapEsbuildPlugin(params?: ImportMapEsbuildPluginParams): Plugin {
  const imports = params?.importMap?.imports ?? {};
  const namespace = '_http_url';
  const timeoutMs = params?.timeoutMs ?? 30_000;
  const loaderResolver = params?.loaderResolver;
  const enableHttp = params?.enableHttp ?? false;
  const prefixKeys = Object.keys(imports)
    .filter(k => k.endsWith('/'))
    .sort((a, b) => b.length - a.length); // longest first

  // Simple bare-specifier test (per spec definition)
  const bareSpecifier = /^[a-zA-Z0-9@][a-zA-Z0-9\-._@/]*$/;

  // Keep a map of resolved paths in case modules redirect
  const pathToResolvedUrl = new Map<string, string>();

  return {
    name: "import-map",
    setup(build) {
      const baseDir =
        params?.baseDir ??
        build.initialOptions.absWorkingDir ??
        process.cwd();

      build.onResolve({ filter: bareSpecifier }, (args) => {
        const spec = args.path;

        // ---- 1. Exact match ----
        if (imports[spec]) {
          const target = imports[spec];
          params?.onLog?.(`Exact match: ${spec} -> ${target}`);
          return resolveTarget(target, baseDir, namespace, enableHttp);
        }

        // ---- 2. Prefix match ("pkg/" style mappings) ----
        for (const key of prefixKeys) {
          if (spec.startsWith(key)) {
            const remainder = spec.slice(key.length);
            const target = imports[key] + remainder;
            params?.onLog?.(`Prefix match: [${key}] ${spec} -> ${target}`);
            return resolveTarget(target, baseDir, namespace, enableHttp);
          }
        }

        // Otherwise fall back to default esbuild resolver
        return;
      });

      // Absolute http(s) import resulting from import map
      build.onResolve({ filter: /^https?:\/\//, namespace }, args => {
        const path = args.path;
        params?.onLog?.(`HTTP entry resolve: ${path}`);
        return { path, namespace };
      });

      // Relative import inside an http(s) module
      build.onResolve({ filter: /^\.\.?\//, namespace }, args => {
        const base = pathToResolvedUrl.get(args.importer) ?? args.importer;
        const path = new URL(args.path, base).toString();
        params?.onLog?.(`Resolved: ${args.path} -> ${path}`);
        return { path, namespace };
      });

      // Load files from inside an http(s) module
      build.onLoad({ filter: /.*/, namespace }, async (args) => {
        params?.onLog?.(`Downloading: ${args.path}`);

        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), timeoutMs);

        let res: Response;
        try {
          // NOTE: This also follows redirects, as { redirect: 'follow' } by default
          res = await fetch(args.path, { signal: abortController.signal });
        } finally {
          clearTimeout(timer);
        }

        if (!res.ok) {
          throw new Error(`GET ${args.path} failed: status ${res.status}`);
        }

        const resolvedUrl = res.url || args.path; // res.url is empty string in tests
        pathToResolvedUrl.set(args.path, resolvedUrl);

        const contents = new Uint8Array(await res.arrayBuffer());

        const loader =
          (loaderResolver != null ? await loaderResolver({path: args.path, namespace: args.namespace, with: args.with}, res) : null) ??
          loaderFromPathname(new URL(args.path).pathname) ??
          loaderFromContentType(res.headers.get("content-type")) ??
          "js";

        return { contents, loader };
      });
    },
  } satisfies Plugin;
}

function resolveTarget(
  target: string,
  baseDir: string,
  httpNamespace: string,
  enableHttp: boolean,
): OnResolveResult {
  if (/^https?:\/\//.test(target)) {
    if (!enableHttp) {
      throw new Error(
        `${PLUGIN_NAME}: HTTP(S) imports are disabled. ` +
        `Tried to map specifier to ${target} without enableHttp: true.`
      );
    }
    return { path: target, namespace: httpNamespace };
  }

  const abs = isAbsolute(target)
    ? target
    : resolve(baseDir, target);

  return { path: abs };
}

const EXT_TO_LOADER: Record<string, Loader> = {
  js: "js",
  mjs: "js",
  cjs: "js",
  ts: "ts",
  mts: "ts",
  cts: "ts",
  jsx: "jsx",
  tsx: "tsx",
  json: "json",
  css: "css",
  txt: "text",
};

function loaderFromPathname(pathname: string): Loader | undefined {
  const last = pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0) {
    return undefined;
  }

  const ext = last.slice(dot + 1).toLowerCase();
  return EXT_TO_LOADER[ext];
}

function loaderFromContentType(contentType: string | null): Loader | undefined {
  if (contentType == null) {
    return undefined;
  }
  const t = contentType.split(';')[0].trim().toLowerCase();
  switch (t) {
    case 'application/javascript':
    case 'text/javascript':
      return 'js';
    case 'application/typescript':
    case 'text/typescript':
      return 'ts';
    case 'application/json':
    case 'text/json':
      return 'json';
    case 'text/css':
      return 'css';
    case 'text/plain':
      return 'text';
  }
  return undefined;
}
